// Unit tests for analyze_stock's computation and the shared number/date helpers.
// Run from the repo root: deno task test

import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1.0.19'
import { analyze, eok, mean, normDate, pct, round, type Row, stddev } from './analyze.ts'

// ---- helpers --------------------------------------------------------------------------------------

type Day = { close: number; trdval?: number; volume?: number; high?: number; low?: number }

// Builds rows from days given OLDEST FIRST (easier to read), and returns them most-recent-first like the DB query.
// Defaults: high/low = close ±1%, 거래대금 100억, 거래량 100k, 등락률 from the previous close.
function makeRows(days: Day[]): Row[] {
  const start = Date.UTC(2026, 0, 1)
  const rows = days.map((d, i): Row => {
    const prev = i > 0 ? days[i - 1].close : d.close
    return {
      bas_dd: new Date(start + i * 86400_000).toISOString().slice(0, 10),
      isu_cd: '005930',
      isu_nm: '테스트전자',
      market: 'KOSPI',
      sect_tp_nm: null,
      close: d.close,
      change: d.close - prev,
      fluc_rt: round((d.close / prev - 1) * 100),
      open: d.close,
      high: d.high ?? d.close * 1.01,
      low: d.low ?? d.close * 0.99,
      volume: d.volume ?? 100_000,
      trdval: d.trdval ?? 10_000_000_000,
      mktcap: 1_000_000_000_000,
    }
  })
  return rows.reverse()
}

const flat = (n: number, close = 100, extra: Partial<Day> = {}): Day[] => Array.from({ length: n }, () => ({ close, ...extra }))

const OPTS = { avg_days: 20, spike_ratio: 3, sideways_days: 20, sideways_max_range: 15 }

const codes = (r: ReturnType<typeof analyze>) => r.signals.map((s) => s.code)

// Walks any value and collects paths whose number is NaN or ±Infinity (JSON.stringify would silently turn them into null)
function badNumbers(v: unknown, path = '$'): string[] {
  if (typeof v === 'number') return Number.isFinite(v) ? [] : [path]
  if (Array.isArray(v)) return v.flatMap((x, i) => badNumbers(x, `${path}[${i}]`))
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => badNumbers(x, `${path}.${k}`))
  return []
}

// ---- small helpers ----------------------------------------------------------------------------------

Deno.test('normDate accepts both date formats', () => {
  assertEquals(normDate('2026-10-08'), '2026-10-08')
  assertEquals(normDate('20261008'), '2026-10-08')
})

Deno.test('number helpers handle null, zero and NaN', () => {
  assertEquals(eok(12_345_678_901), 123)
  assertEquals(eok(null), null)
  assertEquals(round(1.23456), 1.23)
  assertEquals(round(1.5, 0), 2)
  assertEquals(round(NaN), null)
  assertEquals(round(Infinity), null)
  assertEquals(pct(110, 100), 10)
  assertEquals(pct(100, 0), null) // no division by zero
  assertEquals(pct(null, 100), null)
  assertEquals(mean([]), null)
  assertEquals(mean([1, 2, 3]), 2)
  assertEquals(stddev([5]), null)
  assertAlmostEquals(stddev([2, 4, 4, 4, 5, 5, 7, 9])!, 2.138, 1e-3) // sample stddev (n - 1)
})

Deno.test('round matches Postgres round(numeric): decimal digits, halves away from zero', () => {
  // floats store these just below the half (1.005 = 1.00499999…), so naive * 100 rounding goes down
  assertEquals(round(1.005), 1.01)
  assertEquals(round(8_040_000_000 / 8_000_000_000), 1.01) // the seeded 900010 ratio
  assertEquals(round(2.675), 2.68)
  assertEquals(round(1.0049), 1)
  // halves away from zero, also below it (Math.round(-100.5) is -100)
  assertEquals(round(-1.005), -1.01)
  assertEquals(round(-2.5, 0), -3)
  assertEquals(round(-0.001), 0) // not -0
  // very small and large values keep working
  assertEquals(round(1e-7), 0)
  assertEquals(round(123_456_789.125), 123_456_789.13)
  assertEquals(round(0), 0)
})

// ---- analyze ------------------------------------------------------------------------------------

Deno.test('short history (new listing): long-window metrics are null, never NaN', () => {
  const r = analyze(makeRows([{ close: 100 }, { close: 102 }, { close: 101 }, { close: 105 }, { close: 104 }]), OPTS)
  assertEquals(r.history_days, 5)
  assertEquals(r.returns_pct.d1, -0.95)
  assertEquals(r.returns_pct.d5, null)
  assertEquals(r.returns_pct.d120, null)
  assertEquals((r.moving_averages as Record<string, unknown>).ma20, { value: null, close_vs_ma_pct: null, slope_5d_pct: null })
  assertEquals(r.consolidation, null)
  // averages use the 4 prior days that exist; breakouts aren't called without a full window
  assertEquals(r.trading_value.avg_prior_days, 4)
  assertEquals(r.trading_value.ratio_vs_avg, 1)
  assertEquals(r.breakouts.d20?.prior_days, 4)
  assertEquals(r.breakouts.d20?.breakout, null)
  assert(codes(r).includes('SHORT_HISTORY'))
  assertEquals(badNumbers(r), [])
})

Deno.test('new listing (IPO): spike is measured against the days since listing, no breakout yet', () => {
  // 10 trading days since listing; on the last day 거래대금 is 4× the prior average and the close is a new high
  const r = analyze(makeRows([...flat(9), { close: 120, trdval: 40_000_000_000 }]), OPTS)
  assertEquals(r.trading_value.avg_prior_days, 9)
  assertEquals(r.trading_value.ratio_vs_avg, 4)
  assert(codes(r).includes('TRDVAL_SPIKE'))
  assertEquals(r.signals.find((s) => s.code === 'TRDVAL_SPIKE')?.detail, '거래대금이 직전 9일 평균의 4배')
  assertEquals(r.breakouts.d20?.prior_high, 101) // high since listing, still reported
  assertEquals(r.breakouts.d20?.breakout, null)
  assert(!codes(r).some((c) => c.startsWith('BREAKOUT_')))
  assert(codes(r).includes('SHORT_HISTORY'))
})

Deno.test('full history: no SHORT_HISTORY signal', () => {
  assert(!codes(analyze(makeRows(flat(30)), OPTS)).includes('SHORT_HISTORY'))
})

Deno.test('single row (listing day) does not crash', () => {
  const r = analyze(makeRows([{ close: 100 }]), OPTS)
  assertEquals(r.history_days, 1)
  assertEquals(r.trading_value.ratio_vs_avg, null) // no prior day to compare with
  assertEquals(r.breakouts.d20, null)
  assertEquals(badNumbers(r), [])
})

Deno.test('golden cross 5/20 fires on the crossing day only', () => {
  // Yesterday: MA5 96 < MA20 99. Today: MA5 102 > MA20 100.5
  const days = [...flat(24), ...flat(4, 95), { close: 130 }]
  assert(codes(analyze(makeRows(days), OPTS)).includes('GOLDEN_CROSS_5_20'))
  // One day later MA5 is still above MA20, but that's not a new cross
  assert(!codes(analyze(makeRows([...days, { close: 130 }]), OPTS)).includes('GOLDEN_CROSS_5_20'))
})

Deno.test('dead cross 5/20', () => {
  const days = [...flat(24), ...flat(4, 105), { close: 70 }]
  assert(codes(analyze(makeRows(days), OPTS)).includes('DEAD_CROSS_5_20'))
})

Deno.test('bullish alignment needs 120 days of steadily rising closes', () => {
  const rising = Array.from({ length: 130 }, (_, i) => ({ close: 100 + i }))
  const r = analyze(makeRows(rising), OPTS)
  assertEquals(r.moving_averages.bullish_alignment, true)
  assert(codes(r).includes('MA_BULLISH_ALIGNMENT'))
  // With fewer than 120 days there is no MA120, so no alignment either way
  const short = analyze(makeRows(rising.slice(0, 100)), OPTS)
  assertEquals(short.moving_averages.bullish_alignment, false)
})

Deno.test('20-day breakout: close above the prior 20-day high', () => {
  const r = analyze(makeRows([...flat(30), { close: 110 }]), OPTS)
  assertEquals(r.breakouts.d20?.breakout, true)
  assertEquals(r.breakouts.d20?.prior_high, 101)
  assert(codes(r).includes('BREAKOUT_20D'))
  assertEquals(r.breakouts.d60?.breakout, null) // only 31 days of history: high reported, no 60-day call
  assert(!codes(r).includes('BREAKOUT_60D'))
})

Deno.test('no breakout when the close only matches the prior high', () => {
  const r = analyze(makeRows([...flat(30), { close: 101, high: 101 }]), OPTS)
  assertEquals(r.breakouts.d20?.breakout, false)
})

Deno.test('no-trade day: flagged, and never counted as a breakout', () => {
  // KRX reports a halted day with open/high/low = 0 and the close carried forward
  const halted = { close: 120, trdval: 0, volume: 0, high: 0, low: 0 }
  const r = analyze(makeRows([...flat(30), halted]), OPTS)
  assertEquals(r.traded_on_date, false)
  assert(codes(r).includes('NO_TRADES'))
  assertEquals(r.breakouts.d20?.breakout, false)
})

Deno.test('halted days inside the window are ignored for prior high/low and the box', () => {
  const halted = { close: 100, trdval: 0, volume: 0, high: 0, low: 0 }
  const r = analyze(makeRows([...flat(25), halted, halted, ...flat(3)]), OPTS)
  assertEquals(r.breakouts.d20?.prior_low, 99) // not 0 from the halted rows
  assertEquals(r.consolidation?.box_low, 99)
  assertEquals(badNumbers(r), [])
})

Deno.test('거래대금 spike vs. the prior 20-day average', () => {
  const r = analyze(makeRows([...flat(25), { close: 100, trdval: 50_000_000_000 }]), OPTS)
  assertEquals(r.trading_value.ratio_vs_avg, 5)
  assertEquals(r.trading_value.today_eok, 500)
  assert(codes(r).includes('TRDVAL_SPIKE'))
  assertEquals(r.trading_value.spikes_last_20d.length, 1)
  // Just under the threshold: no signal
  const r2 = analyze(makeRows([...flat(25), { close: 100, trdval: 29_000_000_000 }]), OPTS)
  assert(!codes(r2).includes('TRDVAL_SPIKE'))
})

Deno.test('up streak counts consecutive higher closes', () => {
  const r = analyze(makeRows([...flat(10), { close: 101 }, { close: 102 }, { close: 103 }]), OPTS)
  assertEquals(r.streaks.consecutive_up_days, 3)
  assertEquals(r.streaks.consecutive_down_days, 0)
  assert(codes(r).includes('PRICE_UP_STREAK'))
})

Deno.test('box with rising 거래대금 (accumulation)', () => {
  // 20 days inside 99–101, 거래대금 doubles in the last 5 days
  const days = [...flat(15, 100, { trdval: 10_000_000_000 }), ...flat(5, 100, { trdval: 20_000_000_000 })]
  const r = analyze(makeRows(days), OPTS)
  assertEquals(r.consolidation?.is_consolidating, true)
  assertEquals(r.consolidation?.trdval_growth, 2)
  assert(codes(r).includes('BOX_WITH_RISING_TRDVAL'))
  assert(!codes(r).includes('CONSOLIDATION')) // the two are exclusive
})

Deno.test('a wide range is not a box', () => {
  const days = Array.from({ length: 20 }, (_, i) => ({ close: i % 2 ? 100 : 130 }))
  const r = analyze(makeRows(days), OPTS)
  assertEquals(r.consolidation?.is_consolidating, false)
  assert(!codes(r).includes('CONSOLIDATION'))
})

Deno.test('avg_days option renames the output keys', () => {
  const r = analyze(makeRows(flat(30)), { ...OPTS, avg_days: 10 })
  assert('avg10_prior_eok' in r.trading_value)
  assert('avg10_prior' in r.volume)
})
