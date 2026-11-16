// Unit tests for the price-row checks (validate.ts) on synthetic rows, so they run without the real fixtures (CI too).
// The real-data versions are in krx-ingest/parse_test.ts and kis-ingest/parse_test.ts.
// Run from the repo root: deno task test

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { type CheckedRow, rowProblems } from './validate.ts'

// n plausible rows: codes 100000.., close 1,000, ±1% range, a few no-trade rows like KRX sends them
function rows(n: number): CheckedRow[] {
  return Array.from({ length: n }, (_, i) => {
    const idle = i % 50 === 0
    return {
      isu_cd: String(100000 + i),
      isu_nm: `종목${i}`,
      close: 1000,
      change: idle ? 0 : 10,
      fluc_rt: idle ? 0 : 1.01,
      open: idle ? 0 : 995,
      high: idle ? 0 : 1010,
      low: idle ? 0 : 990,
      volume: idle ? 0 : 5000,
      trdval: idle ? 0 : 5_000_000,
    }
  })
}
const opts = { minRows: 900 }

Deno.test('plausible rows pass, no-trade rows included', () => {
  assertEquals(rowProblems(rows(1000), opts), [])
})

Deno.test('a renamed field (all nulls) is refused', () => {
  const r = rows(1000).map((x) => ({ ...x, close: null }))
  assertEquals(rowProblems(r, opts), ['close missing in 1000 of 1000 rows'])
})

Deno.test('too few rows, and nothing at all', () => {
  assertEquals(rowProblems(rows(500), opts), ['only 500 rows (expected at least 900)'])
  assertEquals(rowProblems([], opts), ['only 0 rows (expected at least 900)'])
})

Deno.test('a handful of odd rows is tolerated, many are not', () => {
  // 5 listing-day moves beyond ±30%: fine
  const few = rows(1000).map((x, i) => (i < 5 ? { ...x, fluc_rt: 120 } : x))
  assertEquals(rowProblems(few, opts), [])
  // 300: something systematic (e.g. 등락률 now in basis points)
  const many = rows(1000).map((x, i) => (i < 300 ? { ...x, fluc_rt: 120 } : x))
  assertEquals(rowProblems(many, opts), ['등락률 beyond ±30% in 300 of 1000 rows'])
})

Deno.test('swapped high/low is refused', () => {
  const r = rows(1000).map((x) => ({ ...x, high: x.low, low: x.high }))
  assertEquals(rowProblems(r, opts), ['open/close outside low..high in 980 of 1000 rows']) // the 20 no-trade rows have no range
})

Deno.test('duplicate codes, bad codes, missing names', () => {
  const r = rows(1000)
  r[1] = { ...r[1], isu_cd: r[0].isu_cd }
  const bad = r.map((x, i) => (i >= 500 ? { ...x, isu_cd: `X${i}`, isu_nm: '' } : x))
  const p = rowProblems(bad, opts)
  assert(p.includes('1 duplicate 종목코드'), p.join())
  assert(p.includes('종목코드 not 6 letters/digits in 500 of 1000 rows'), p.join())
  assert(p.includes('종목명 empty in 500 of 1000 rows'), p.join())
})

Deno.test('extra numeric fields are checked when asked', () => {
  const r = rows(1000).map((x) => ({ ...x, mktcap: null }))
  assertEquals(rowProblems(r, opts), [])
  assertEquals(rowProblems(r, { ...opts, extraNumeric: ['mktcap'] }), ['mktcap missing in 1000 of 1000 rows'])
})
