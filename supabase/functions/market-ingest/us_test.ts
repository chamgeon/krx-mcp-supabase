// Tests for market-ingest ?set=us. The real-response tests use a yahoo-finance2 quote() answer saved by
// `deno task fixtures yahoo` on 2026-11-26 at 14:26 KST (US Thanksgiving, so the 11-25 close; gitignored, skipped
// without it). The rest use hand-written values.
// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { FIXED_ETFS, GLOBAL, marketQuoteOf, toYahoo, trackedTickers, US_INDICES, US_YIELDS, usQuoteOf } from './us.ts'

const FILE = new URL('./fixtures/yahoo_quote_20261126_1426.json', import.meta.url)
const HAVE = (() => {
  try {
    return Deno.statSync(FILE).isFile
  } catch {
    return false
  }
})()
if (!HAVE) console.warn('market-ingest Yahoo fixture missing: real-response tests skipped (run: deno task fixtures yahoo)')
// deno-lint-ignore no-explicit-any
const quotes: any[] = HAVE ? JSON.parse(Deno.readTextFileSync(FILE)).quotes : []
const bySymbol = new Map(quotes.map((q) => [q.symbol, q]))
const fixtureTest = (name: string, fn: () => void) => Deno.test({ name, ignore: !HAVE, fn })

fixtureTest('every US index and yield is in the answer, dated in New York', () => {
  const got = [...US_INDICES.map((s) => marketQuoteOf(bySymbol.get(s.yahoo), s, 'index')), ...US_YIELDS.map((s) => marketQuoteOf(bySymbol.get(s.yahoo), s, 'rate'))]
  assertEquals(got.map((q) => q?.symbol), ['SPX', 'DJI', 'IXIC', 'RUT', 'SOX', 'VIX', 'US13W', 'US5Y', 'US10Y', 'US30Y'])
  for (const q of got) assertEquals([q!.value_date, q!.source], ['2026-11-25', 'yahoo'])
  assertEquals(got[0], { symbol: 'SPX', kind: 'index', name: 'S&P 500', price: 7182.78, prev_close: 7201.09, unit: 'pt', value_date: '2026-11-25', source: 'yahoo' })
  // Yields: % with Yahoo's float noise rounded (4.9040003 → 4.904)
  assertEquals(got[8], { symbol: 'US10Y', kind: 'rate', name: '미국 10년 국채', price: 4.848, prev_close: 4.904, unit: '%', value_date: '2026-11-25', source: 'yahoo' })
})

fixtureTest('stocks and ETFs: price, day range, volume, cap, delay; a class share maps BRK.B ↔ BRK-B', () => {
  const nvda = usQuoteOf(bySymbol.get('NVDA'), 'NVDA', 'mentioned')!
  assertEquals([nvda.price, nvda.prev_close, nvda.exchange, nvda.quote_type, nvda.value_date, nvda.delay_min], [149.3, 155.38, 'NasdaqGS', 'EQUITY', '2026-11-25', 15])
  assertEquals(nvda.market_cap! > 1e12, true)
  assertEquals(nvda.market_time, '2026-11-25T21:00:01.000Z')
  const brk = usQuoteOf(bySymbol.get(toYahoo('BRK.B')), 'BRK.B', 'mentioned')!
  assertEquals([brk.ticker, brk.exchange, brk.delay_min], ['BRK.B', 'NYSE', 20])
  const spy = usQuoteOf(bySymbol.get('SPY'), 'SPY', 'etf')!
  assertEquals([spy.quote_type, spy.delay_min, spy.tracked_because], ['ETF', 0, 'etf'])
})

fixtureTest('a ticker that does not exist is simply absent from the answer', () => {
  assertEquals(bySymbol.has('ZZZZZQ'), false)
  assertEquals(usQuoteOf(bySymbol.get('ZZZZZQ'), 'ZZZZZQ', 'mentioned'), null)
})

Deno.test('tracked: mentioned and listed first, then the fixed ETFs, each once; unlisted mentions dropped', () => {
  const t = trackedTickers(['NVDA', 'ANTHROPIC', 'SPY', 'ORCL'], new Set(['NVDA', 'SPY', 'ORCL']))
  assertEquals(t.slice(0, 3), [{ ticker: 'NVDA', because: 'mentioned' }, { ticker: 'SPY', because: 'mentioned' }, { ticker: 'ORCL', because: 'mentioned' }])
  assertEquals(t.length, 3 + FIXED_ETFS.length - 1) // SPY counted once
  assertEquals(t.some((x) => x.ticker === 'ANTHROPIC'), false)
  assertEquals(t.filter((x) => x.because === 'etf').map((x) => x.ticker), FIXED_ETFS.filter((e) => e !== 'SPY'))
})

Deno.test('gold, silver, Bitcoin: USD, 2 decimals, kind commodity / crypto (values from 11-26 14:50 KST)', () => {
  const q = (price: number, prev: number) => ({ regularMarketPrice: price, regularMarketPreviousClose: prev, regularMarketTime: new Date('2026-11-26T05:50:35Z') })
  assertEquals(GLOBAL.map((g) => g.yahoo), ['GC=F', 'SI=F', 'BTC-USD'])
  assertEquals(marketQuoteOf(q(3607, 3564.6), GLOBAL[0], 'commodity'), {
    symbol: 'GOLD', kind: 'commodity', name: '금 선물 (COMEX 근월물)', price: 3607, prev_close: 3564.6, unit: 'USD', value_date: '2026-11-26', source: 'yahoo',
  })
  assertEquals(marketQuoteOf(q(41.89, 40.538), GLOBAL[1], 'commodity')!.prev_close, 40.54)
  const btc = marketQuoteOf(q(60671.2345, 60378.57), GLOBAL[2], 'crypto')!
  assertEquals([btc.kind, btc.unit, btc.price], ['crypto', 'USD', 60671.23])
})

Deno.test('market time as Date, epoch seconds or ISO string; no price or time = no row', () => {
  const base = { regularMarketPrice: 10, regularMarketPreviousClose: 9 }
  for (const t of [new Date('2026-11-25T21:00:00Z'), 1795640400, '2026-11-25T21:00:00.000Z']) {
    assertEquals(usQuoteOf({ ...base, regularMarketTime: t }, 'X', 'etf')!.market_time, '2026-11-25T21:00:00.000Z')
  }
  // 23:30 UTC on 11-25 is still 11-25 in New York; 03:00 UTC on 11-26 is 11-25 too
  assertEquals(usQuoteOf({ ...base, regularMarketTime: '2026-11-26T03:00:00Z' }, 'X', 'etf')!.value_date, '2026-11-25')
  assertEquals(usQuoteOf({ regularMarketTime: new Date() }, 'X', 'etf'), null)
  assertEquals(usQuoteOf({ regularMarketPrice: 10 }, 'X', 'etf'), null)
  assertEquals(marketQuoteOf(undefined, US_INDICES[0], 'index'), null)
})
