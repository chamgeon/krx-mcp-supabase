// Parser tests for market-ingest. The real-response tests use KIS answers saved by `deno task fixtures market` on
// 2026-11-26 at 13:11 KST, mid-session (gitignored: third-party data; skipped without them). The rest use small
// hand-written answers.
// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { BONDS, chartDate, FX, inIndexHours, INDICES, parseChart, parseIndex } from './parse.ts'

const FILE = new URL('./fixtures/kis_market_20261126_1311.json', import.meta.url)
const HAVE = (() => {
  try {
    return Deno.statSync(FILE).isFile
  } catch {
    return false
  }
})()
if (!HAVE) console.warn('market-ingest fixture missing: real-response tests skipped (run: deno task fixtures market)')
// deno-lint-ignore no-explicit-any
const res: Record<string, { body: any }> = HAVE ? JSON.parse(Deno.readTextFileSync(FILE)).responses : {}
const fixtureTest = (name: string, fn: () => void) => Deno.test({ name, ignore: !HAVE, fn })

fixtureTest('KOSPI / KOSDAQ from inquire-index-price (mid-session, both up)', () => {
  const day = '2026-11-26'
  const kospi = parseIndex(res['index_0001'].body, INDICES[0], day)!
  const kosdaq = parseIndex(res['index_1001'].body, INDICES[1], day)!
  assertEquals([kospi.symbol, kospi.kind, kospi.unit, kospi.value_date], ['KOSPI', 'index', 'pt', day])
  // prev_close = price − change: matches the chart endpoint's KOSPI previous close (4697.51) at 12:37
  const o = res['index_0001'].body.output
  assertEquals(kospi.price, Number(o.bstp_nmix_prpr))
  assertEquals(kospi.prev_close, Math.round((Number(o.bstp_nmix_prpr) - Number(o.bstp_nmix_prdy_vrss)) * 100) / 100)
  assertEquals(kospi.prev_close, 4697.51)
  assertEquals(kosdaq.symbol, 'KOSDAQ')
})

fixtureTest('KRW/USD from the chart endpoint: value, previous close, today', () => {
  assertEquals(parseChart(res['fx_FX@KRW'].body, FX[0], 'fx', 'KRW'), {
    symbol: 'USDKRW', kind: 'fx', name: '원/달러', price: 1342.9, prev_close: 1344.3, unit: 'KRW', value_date: '2026-11-26', source: 'kis',
  })
})

fixtureTest('국고채 1–30년: every code answers with a yield in % and a date', () => {
  const got = BONDS.map((s) => parseChart(res[`bond_${s.code}`].body, s, 'rate', '%'))
  assertEquals(got.map((q) => q?.symbol), ['KR1Y', 'KR3Y', 'KR5Y', 'KR10Y', 'KR20Y', 'KR30Y'])
  for (const q of got) {
    assertEquals(q!.value_date, '2026-11-26')
    assertEquals(q!.price > 1 && q!.price < 10, true, `${q!.symbol} ${q!.price}`)
  }
  assertEquals([got[1]!.price, got[1]!.prev_close], [3.635, 3.583])
})

fixtureTest('an unknown code answers rt_cd 0 with zeros: no quote', () => {
  const b = res['bond_Y0999'].body
  assertEquals(b.rt_cd, '0')
  assertEquals(parseChart(b, { symbol: 'X', code: 'Y0999', name: 'x' }, 'rate', '%'), null)
  assertEquals(chartDate(b), null)
})

Deno.test('index change is signed by prdy_vrss_sign (5 = 하락, 3 = 보합)', () => {
  const body = (vrss: string, sign: string) => ({ output: { bstp_nmix_prpr: '2500.00', bstp_nmix_prdy_vrss: vrss, prdy_vrss_sign: sign } })
  assertEquals(parseIndex(body('12.34', '5'), INDICES[0], '2026-11-27')!.prev_close, 2512.34)
  assertEquals(parseIndex(body('-12.34', '5'), INDICES[0], '2026-11-27')!.prev_close, 2512.34)
  assertEquals(parseIndex(body('12.34', '2'), INDICES[0], '2026-11-27')!.prev_close, 2487.66)
  assertEquals(parseIndex(body('0.00', '3'), INDICES[0], '2026-11-27')!.prev_close, 2500)
  assertEquals(parseIndex({ output: { bstp_nmix_prpr: '' } }, INDICES[0], '2026-11-27'), null)
})

Deno.test('values are rounded to the unit: KIS float noise ("1344.2999") is dropped', () => {
  const body = { output1: { ovrs_nmix_prpr: '1342.7000', ovrs_nmix_prdy_clpr: '1344.2999' }, output2: [{ stck_bsop_date: '20261126' }] }
  const q = parseChart(body, FX[0], 'fx', 'KRW')!
  assertEquals([q.price, q.prev_close], [1342.7, 1344.3])
  const y = parseChart({ ...body, output1: { ovrs_nmix_prpr: '3.63499999', ovrs_nmix_prdy_clpr: '3.5830' } }, BONDS[1], 'rate', '%')!
  assertEquals([y.price, y.prev_close], [3.635, 3.583])
})

Deno.test('index hours: 09:00–15:40 KST', () => {
  const kst = (hm: string) => new Date(`2026-11-27T${hm}:00+09:00`)
  assertEquals(['08:59', '09:00', '15:40', '15:41', '23:00'].map((t) => inIndexHours(kst(t))), [false, true, true, false, false])
})
