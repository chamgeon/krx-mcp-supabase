// market-ingest ?set=us: US indices, Treasury yields and tracked US stocks / ETFs from Yahoo Finance (yahoo-finance2),
// all in one quote() call per 1,000 symbols. Pure functions here; the fetch and the writes are in index.ts.

import type { Quote } from './parse.ts'

type Spec = { symbol: string; yahoo: string; name: string }

// Into market_quotes. Yahoo states its own delay per symbol (11-26): S&P 500, Dow, Nasdaq, SOX real time; Russell 2000,
// VIX and the yields 15 minutes.
export const US_INDICES: Spec[] = [
  { symbol: 'SPX', yahoo: '^GSPC', name: 'S&P 500' },
  { symbol: 'DJI', yahoo: '^DJI', name: 'Dow Jones Industrial Average' },
  { symbol: 'IXIC', yahoo: '^IXIC', name: 'Nasdaq Composite' },
  { symbol: 'RUT', yahoo: '^RUT', name: 'Russell 2000' },
  { symbol: 'SOX', yahoo: '^SOX', name: 'PHLX Semiconductor' },
  { symbol: 'VIX', yahoo: '^VIX', name: 'CBOE Volatility Index' },
]
// Yahoo quotes these as the yield in % (4.848 = 4.848%)
export const US_YIELDS: Spec[] = [
  { symbol: 'US13W', yahoo: '^IRX', name: '미국 13주 T-Bill' },
  { symbol: 'US5Y', yahoo: '^FVX', name: '미국 5년 국채' },
  { symbol: 'US10Y', yahoo: '^TNX', name: '미국 10년 국채' },
  { symbol: 'US30Y', yahoo: '^TYX', name: '미국 30년 국채' },
]
// ?set=global, every 10 min, every day (they trade outside US stock hours): gold and silver as COMEX front-month
// futures (Yahoo has no spot gold / silver; 10 min delayed), Bitcoin (real time, 24/7). USD per troy ounce / per coin.
export const GLOBAL: (Spec & { kind: 'commodity' | 'crypto' })[] = [
  { symbol: 'GOLD', yahoo: 'GC=F', name: '금 선물 (COMEX 근월물)', kind: 'commodity' },
  { symbol: 'SILVER', yahoo: 'SI=F', name: '은 선물 (COMEX 근월물)', kind: 'commodity' },
  { symbol: 'BTC', yahoo: 'BTC-USD', name: 'Bitcoin', kind: 'crypto' },
]

// Always tracked, mentioned or not: broad market, Nasdaq 100, Dow, small caps, semiconductors, tech, long Treasuries,
// gold, and the leveraged ETFs Korean retail trades most. Edit freely; us_symbols has (almost) no ETFs.
export const FIXED_ETFS = ['SPY', 'VOO', 'QQQ', 'DIA', 'IWM', 'SOXX', 'SMH', 'XLK', 'TLT', 'GLD', 'TQQQ', 'SOXL']

export const MENTION_DAYS = 90
export const QUOTE_BATCH = 1000 // symbols per quote() call (1,000 answered in 1.6 s on 11-26)

/** Yahoo writes class shares with '-' (BRK-B); us_symbols with '.' (BRK.B). */
export const toYahoo = (ticker: string) => ticker.replace(/\./g, '-')

/**
 * The tickers to quote: the mentioned ones that exist in us_symbols (so a gate mistake that isn't a listed ticker is
 * dropped), then the fixed ETFs; each once, mentioned first.
 */
export function trackedTickers(mentioned: Iterable<string>, listed: Set<string>): { ticker: string; because: 'mentioned' | 'etf' }[] {
  const out = new Map<string, 'mentioned' | 'etf'>()
  for (const t of mentioned) if (listed.has(t)) out.set(t, 'mentioned')
  for (const t of FIXED_ETFS) if (!out.has(t)) out.set(t, 'etf')
  return [...out].map(([ticker, because]) => ({ ticker, because }))
}

const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const round = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : null)
// deno-lint-ignore no-explicit-any
type YQuote = Record<string, any>
const timeOf = (q: YQuote): Date | null => {
  const t = q.regularMarketTime
  if (t == null) return null
  const d = t instanceof Date ? t : new Date(typeof t === 'number' ? t * (t < 1e12 ? 1000 : 1) : t)
  return Number.isNaN(d.getTime()) ? null : d
}

const UNIT: Record<'index' | 'rate' | 'commodity' | 'crypto', Quote['unit']> = { index: 'pt', rate: '%', commodity: 'USD', crypto: 'USD' }

/** A Yahoo quote of an index, a yield, a commodity or a coin as a market_quotes row; null without a price or time. */
export function marketQuoteOf(q: YQuote | undefined, spec: Spec, kind: 'index' | 'rate' | 'commodity' | 'crypto'): Quote | null {
  const d = kind === 'rate' ? 3 : 2
  const price = round(q?.regularMarketPrice, d)
  const t = q && timeOf(q)
  if (price == null || !t) return null
  return {
    symbol: spec.symbol, kind, name: spec.name, price, prev_close: round(q!.regularMarketPreviousClose, d),
    unit: UNIT[kind], value_date: nyDate.format(t), source: 'yahoo',
  }
}

export type UsQuote = {
  ticker: string; name: string | null; exchange: string | null; quote_type: string | null
  price: number; prev_close: number | null; open: number | null; high: number | null; low: number | null
  volume: number | null; market_cap: number | null; market_state: string | null; market_time: string
  value_date: string; delay_min: number | null; tracked_because: 'mentioned' | 'etf'
}

/** A Yahoo quote of a stock / ETF as a us_quotes row; null without a price or time. */
export function usQuoteOf(q: YQuote | undefined, ticker: string, because: 'mentioned' | 'etf'): UsQuote | null {
  const price = round(q?.regularMarketPrice, 4)
  const t = q && timeOf(q)
  if (price == null || !t) return null
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
  return {
    ticker, name: q!.shortName ?? q!.longName ?? null, exchange: q!.fullExchangeName ?? null, quote_type: q!.quoteType ?? null,
    price, prev_close: round(q!.regularMarketPreviousClose, 4), open: round(q!.regularMarketOpen, 4),
    high: round(q!.regularMarketDayHigh, 4), low: round(q!.regularMarketDayLow, 4),
    volume: int(q!.regularMarketVolume), market_cap: int(q!.marketCap), market_state: q!.marketState ?? null,
    market_time: t.toISOString(), value_date: nyDate.format(t), delay_min: int(q!.exchangeDataDelayedBy), tracked_because: because,
  }
}
