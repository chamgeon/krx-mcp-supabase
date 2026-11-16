// Parser tests against a real KIS intstock-multprice response (fixtures/, saved by `deno task fixtures kis` on
// 2026-11-16 at 11:55 KST, mid-session). The stock list (`prev`) comes from the saved KRX response of the day before,
// as kis-ingest takes it from the latest stored day.
// Run from the repo root: deno task test

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { krxItems, parseKrxRows } from '../krx-ingest/parse.ts'
import { kisSnapshotProblems, parseKisRows, type Prev } from './parse.ts'

// The fixtures are gitignored (third-party data, public repo): fetch them with `deno task fixtures`. Without them these
// tests are skipped, not failed, so a fresh clone and CI still pass.
const FILES = [
  new URL('./fixtures/intstock_multprice_20261116.json', import.meta.url),
  new URL('../krx-ingest/fixtures/stk_bydd_trd_20261113.json', import.meta.url),
  new URL('../krx-ingest/fixtures/ksq_bydd_trd_20261113.json', import.meta.url),
]
const HAVE = FILES.every((f) => {
  try {
    return Deno.statSync(f).isFile
  } catch {
    return false
  }
})
if (!HAVE) console.warn('kis-ingest fixtures missing: real-response tests skipped (run: deno task fixtures)')
const fixture = HAVE ? JSON.parse(Deno.readTextFileSync(FILES[0])) : { body: { output: [] }, requested_codes: [] }
const output: Record<string, string>[] = fixture.body.output

const krxFile = (path: string) =>
  HAVE ? JSON.parse(Deno.readTextFileSync(new URL(`../krx-ingest/fixtures/${path}_20261113.json`, import.meta.url))) : {}
const prevDay = [
  ...parseKrxRows(krxItems(krxFile('stk_bydd_trd')), 'KOSPI', '20261113'),
  ...parseKrxRows(krxItems(krxFile('ksq_bydd_trd')), 'KOSDAQ', '20261113'),
]
const byCode = new Map<string, Prev>(prevDay.map((r) => [r.isu_cd, r]))
const krxClose = new Map(prevDay.map((r) => [r.isu_cd, r.close]))

const fixtureTest = (name: string, fn: () => void) => Deno.test({ name, ignore: !HAVE, fn })

const TODAY = '2026-11-16'
const rows = parseKisRows(output, byCode, TODAY, fixture.fetched_at)
const row = (code: string) => rows.find((r) => r.isu_cd === code)!

fixtureTest('every requested stock comes back once; the unknown code is dropped', () => {
  assertEquals(fixture.body.rt_cd, '0')
  assertEquals(output.length, 30)
  assertEquals(rows.map((r) => r.isu_cd), fixture.requested_codes.filter((c: string) => c !== '999999'))
  // KIS answers an unknown code with a row of empty strings
  assert(Object.values(output[29]).every((v) => v === ''))
})

fixtureTest('one row, field by field (삼성전자, mid-session)', () => {
  assertEquals(row('005930'), {
    bas_dd: TODAY,
    isu_cd: '005930',
    isu_nm: '삼성전자',
    market: 'KOSPI', // carried from the KRX day
    sect_tp_nm: null,
    close: 199000,
    change: -7000, // signed: KIS sends "-7000"
    fluc_rt: -3.4,
    open: 206500,
    high: 208000,
    low: 197600,
    volume: 7954272,
    trdval: 1608725328350,
    mktcap: 199000 * byCode.get('005930')!.list_shrs!,
    list_shrs: byCode.get('005930')!.list_shrs,
    source: 'kis',
    as_of: '2026-11-16T02:55:52.320Z',
  })
})

fixtureTest('carried-forward fields and 시가총액 for every row', () => {
  for (const r of rows) {
    const p = byCode.get(r.isu_cd)!
    assertEquals([r.market, r.sect_tp_nm, r.list_shrs], [p.market, p.sect_tp_nm, p.list_shrs], r.isu_cd)
    assertEquals(r.mktcap, r.close! * p.list_shrs!, r.isu_cd)
  }
  assertEquals(row('028300').market, 'KOSDAQ') // HLB
  assertEquals(row('028300').sect_tp_nm, '중견기업부')
})

fixtureTest('the sign of 전일대비 matches 등락률', () => {
  for (const r of rows) assertEquals(Math.sign(r.change!), Math.sign(r.fluc_rt!), r.isu_cd)
  assert(rows.some((r) => r.change! < 0) && rows.some((r) => r.change! > 0))
})

// Same format as KRX, so analyze() / screen_stocks skip these prices on the live day too
fixtureTest('no-trade stocks look like KRX no-trade days: open/high/low 0, volume 0', () => {
  for (const code of ['000300', '009440', '119650', '021045']) {
    const r = row(code)
    assertEquals([r.open, r.high, r.low, r.volume, r.trdval, r.change], [0, 0, 0, 0, 0, 0], code)
    assertEquals(r.close, krxClose.get(code), code) // last price carried
  }
})

fixtureTest('traded rows: open and price within low..high', () => {
  for (const r of rows.filter((r) => r.trdval! > 0)) {
    assert(r.low! <= r.open! && r.open! <= r.high!, r.isu_cd)
    assert(r.low! <= r.close! && r.close! <= r.high!, r.isu_cd)
  }
})

// Cross-source check: KIS's previous close must equal what KRX published for that day. If this ever fails on a new
// fixture, the two sources disagree about the same stock.
fixtureTest("KIS's previous close equals KRX's close of the list day", () => {
  for (const r of output.filter((r) => r.inter_shrn_iscd)) {
    assertEquals(Number(r.inter2_prdy_clpr), krxClose.get(r.inter_shrn_iscd), r.inter_shrn_iscd)
  }
})

fixtureTest('name falls back to the stored one; empty output is no rows', () => {
  const [r] = parseKisRows([{ ...output[0], inter_kor_isnm: '' }], byCode, TODAY, 'x')
  assertEquals(r.isu_nm, '삼성전자')
  assertEquals(parseKisRows(undefined, byCode, TODAY, 'x'), [])
  assertEquals(parseKisRows([], byCode, TODAY, 'x'), [])
})

// ---- validation (kisSnapshotProblems)

fixtureTest('validation: the real snapshot passes (29 of 30 requested, one unknown code)', () => {
  assertEquals(kisSnapshotProblems(rows, 30), [])
})

fixtureTest('validation: a renamed price field is refused', () => {
  const edited = output.map(({ inter2_prpr: v, ...r }) => ({ ...r, inter2_price: v }))
  const p = kisSnapshotProblems(parseKisRows(edited, byCode, TODAY, 'x'), 30)
  assertEquals(p, ['close missing in 29 of 29 rows'])
})

fixtureTest('validation: a renamed code field (nothing matches the stock list) is refused', () => {
  const edited = output.map(({ inter_shrn_iscd: v, ...r }) => ({ ...r, stck_shrn_iscd: v }))
  assertEquals(kisSnapshotProblems(parseKisRows(edited, byCode, TODAY, 'x'), 30), ['only 0 rows (expected at least 28)'])
})

Deno.test('validation: an empty snapshot is refused', () => {
  assertEquals(kisSnapshotProblems([], 2770), ['only 0 rows (expected at least 2631)'])
})
