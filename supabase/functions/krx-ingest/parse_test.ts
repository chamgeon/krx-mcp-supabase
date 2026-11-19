// Parser tests against real KRX responses for 2026-11-13 (fixtures/, saved by `deno task fixtures krx 20261113`).
// They also pin down what the rest of the code assumes about KRX data (halted-day format, 시가총액 definition, …), so a
// new fixture that breaks an assumption fails here first.
// Run from the repo root: deno task test

import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import { krxDayProblems, krxItems, parseKrxRows, type PriceRow } from './parse.ts'

const DAY = '20261113'
// The fixtures are gitignored (third-party data, public repo): fetch them with `deno task fixtures`. Without them these
// tests are skipped, not failed, so a fresh clone and CI still pass.
const file = (path: string) => new URL(`./fixtures/${path}_${DAY}.json`, import.meta.url)
const HAVE = ['stk_bydd_trd', 'ksq_bydd_trd'].every((p) => {
  try {
    return Deno.statSync(file(p)).isFile
  } catch {
    return false
  }
})
if (!HAVE) console.warn('krx-ingest fixtures missing: real-response tests skipped (run: deno task fixtures)')
const raw = (path: string) => (HAVE ? JSON.parse(Deno.readTextFileSync(file(path))) : {})
const kospi = parseKrxRows(krxItems(raw('stk_bydd_trd')), 'KOSPI', DAY)
const kosdaq = parseKrxRows(krxItems(raw('ksq_bydd_trd')), 'KOSDAQ', DAY)
const fixtureTest = (name: string, fn: () => void) => Deno.test({ name, ignore: !HAVE, fn })
const all = [...kospi, ...kosdaq]

const NUMERIC = ['close', 'change', 'fluc_rt', 'open', 'high', 'low', 'volume', 'trdval', 'mktcap', 'list_shrs'] as const
const traded = (r: PriceRow) => r.trdval! > 0

fixtureTest('every stock of a real trading day is parsed', () => {
  assertEquals([kospi.length, kosdaq.length], [936, 1834])
  assertEquals(new Set(all.map((r) => r.isu_cd)).size, all.length) // no duplicates
  assert(all.every((r) => r.bas_dd === '2026-11-13' && r.source === 'krx' && r.as_of === null))
  assert(all.every((r) => r.isu_nm && r.isu_nm === r.isu_nm.trim()))
  assert(kospi.every((r) => r.market === 'KOSPI') && kosdaq.every((r) => r.market === 'KOSDAQ'))
})

fixtureTest('one row, field by field', () => {
  assertEquals(kospi.find((r) => r.isu_cd === '095570'), {
    bas_dd: '2026-11-13',
    isu_cd: '095570',
    isu_nm: 'AJ네트웍스',
    market: 'KOSPI',
    sect_tp_nm: null, // KRX sends '' for KOSPI
    close: 4120,
    change: 20,
    fluc_rt: 0.49,
    open: 4100,
    high: 4150,
    low: 4080,
    volume: 151063,
    trdval: 620624862,
    mktcap: 186441367080,
    list_shrs: 45252759,
    source: 'krx',
    as_of: null,
  })
})

fixtureTest('every numeric field parses on every row', () => {
  for (const r of all) for (const k of NUMERIC) assert(r[k] !== null, `${r.isu_cd} ${k} is null`)
})

fixtureTest('소속부: KOSPI has none, KOSDAQ keeps it', () => {
  assert(kospi.every((r) => r.sect_tp_nm === null))
  const kinds = new Set(kosdaq.map((r) => r.sect_tp_nm))
  for (const k of ['우량기업부', '벤처기업부', '기술성장기업부', 'SPAC(소속부없음)']) assert(kinds.has(k), k)
})

fixtureTest('alphanumeric 종목코드 (e.g. 0099X0) are kept as text', () => {
  const alnum = all.filter((r) => !/^\d{6}$/.test(r.isu_cd))
  assertEquals(alnum.length, 96)
  assert(alnum.every((r) => /^[0-9A-Z]{6}$/.test(r.isu_cd)))
})

// analyze() and screen_stocks treat "거래대금 0, high 0" as a no-trade day and skip its prices
fixtureTest('no-trade days: open/high/low 0, close carried forward, volume 0', () => {
  const idle = all.filter((r) => !traded(r))
  assertEquals(idle.length, 107)
  for (const r of idle) {
    assertEquals([r.open, r.high, r.low, r.volume, r.change, r.fluc_rt], [0, 0, 0, 0, 0, 0], r.isu_cd)
    assert(r.close! > 0, r.isu_cd)
  }
})

fixtureTest('traded rows are internally consistent', () => {
  for (const r of all.filter(traded)) {
    assert(r.low! <= r.open! && r.open! <= r.high!, `${r.isu_cd} open outside low..high`)
    assert(r.low! <= r.close! && r.close! <= r.high!, `${r.isu_cd} close outside low..high`)
    assert(Math.abs(r.fluc_rt!) <= 30, `${r.isu_cd} 등락률 ${r.fluc_rt} beyond the ±30% limit`)
    // 등락률 = 전일대비 / 전일종가, within one rounding step (KRX rounds half away from zero: -0.625 → -0.63)
    const prev = r.close! - r.change!
    if (prev > 0) assert(Math.abs((r.change! / prev) * 100 - r.fluc_rt!) <= 0.0051, `${r.isu_cd} 등락률`)
  }
})

fixtureTest('시가총액 = 종가 × 상장주식수 (kis-ingest computes it the same way)', () => {
  for (const r of all) assertEquals(r.mktcap, r.close! * r.list_shrs!, r.isu_cd)
})

Deno.test('empty responses: holiday, missing block, garbage', () => {
  assertEquals(krxItems({ OutBlock_1: [] }), []) // holiday / not published yet
  assertEquals(krxItems({}), [])
  assertEquals(krxItems(null), [])
  assertEquals(parseKrxRows([{ ISU_CD: '', ISU_NM: 'x' }], 'KOSPI', DAY), []) // rows without a code are skipped
})

// ---- validation (krxDayProblems): the real day passes; edited copies of it, simulating format changes, are refused

// Copy of a market's raw items with one KRX field renamed, as an upstream format change would do
const renamed = (path: string, from: string, to: string) =>
  krxItems(raw(path)).map((r: Record<string, string>) => {
    const { [from]: v, ...rest } = r
    return { ...rest, [to]: v }
  })

fixtureTest('validation: the real day passes', () => {
  assertEquals(krxDayProblems(kospi, kosdaq, 2770), [])
  assertEquals(krxDayProblems(kospi, kosdaq, null), []) // first load: absolute floor only
})

fixtureTest('validation: a renamed price field is refused', () => {
  const k1 = parseKrxRows(renamed('stk_bydd_trd', 'TDD_CLSPRC', 'TDD_CLS_PRC'), 'KOSPI', DAY)
  const k2 = parseKrxRows(renamed('ksq_bydd_trd', 'TDD_CLSPRC', 'TDD_CLS_PRC'), 'KOSDAQ', DAY)
  assertEquals(krxDayProblems(k1, k2, 2770), ['close missing in 2770 of 2770 rows'])
})

fixtureTest('validation: a renamed block in one market is refused, not stored as half a day', () => {
  // OutBlock_1 renamed in KOSDAQ only → it parses as no rows
  const k2 = parseKrxRows(krxItems({ OutBlock_2: krxItems(raw('ksq_bydd_trd')) }), 'KOSDAQ', DAY)
  assertEquals(krxDayProblems(kospi, k2, 2770), ['KOSDAQ returned no rows but KOSPI did', 'only 936 rows (expected at least 2493)'])
})

fixtureTest('validation: a day with a third of the stocks missing is refused', () => {
  const p = krxDayProblems(kospi, kosdaq.slice(0, 900), 2770)
  assertEquals(p, ['only 1836 rows (expected at least 2493)'])
})

Deno.test('validation: holiday (both markets empty) is fine', () => {
  assertEquals(krxDayProblems([], [], 2770), [])
})
