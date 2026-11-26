// What market-ingest stores, and how KIS answers become market_quotes rows.

import { num } from '../_shared/kis.ts'

export type Kind = 'index' | 'fx' | 'rate' | 'commodity' | 'crypto'
export type Quote = {
  symbol: string
  kind: Kind
  name: string
  price: number
  prev_close: number | null
  unit: 'pt' | 'KRW' | '%' | 'USD'
  value_date: string // YYYY-MM-DD, the trading day the value belongs to
  source: 'kis' | 'yahoo'
}

type Spec = { symbol: string; code: string; name: string }

// KOSPI / KOSDAQ: KIS domestic index codes (inquire-index-price, market U)
export const INDICES: Spec[] = [
  { symbol: 'KOSPI', code: '0001', name: 'KOSPI' },
  { symbol: 'KOSDAQ', code: '1001', name: 'KOSDAQ' },
]
// KRW per USD from 서울외국환중개 (KIS's "원/달러(KMB)"): real time, 09:00–02:00 KST
export const FX: Spec[] = [{ symbol: 'USDKRW', code: 'FX@KRW', name: '원/달러' }]
// 국고채 yields (KIS overseas chart, market I). KIS has today's value during the day, but not continuously; fetched
// once a day, in the evening, for the day's final value.
export const BONDS: Spec[] = [
  { symbol: 'KR1Y', code: 'Y0104', name: '국고채 1년' },
  { symbol: 'KR3Y', code: 'Y0101', name: '국고채 3년' },
  { symbol: 'KR5Y', code: 'Y0105', name: '국고채 5년' },
  { symbol: 'KR10Y', code: 'Y0106', name: '국고채 10년' },
  { symbol: 'KR20Y', code: 'Y0116', name: '국고채 20년' },
  { symbol: 'KR30Y', code: 'Y0117', name: '국고채 30년' },
]

const isoDate = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
// KIS sends some values with float noise ("1344.2999" for 1344.3): rounded to the unit's precision
const DECIMALS: Record<Quote['unit'], number> = { pt: 2, KRW: 2, '%': 3, USD: 2 }
const round = (v: number | null, unit: Quote['unit']) => v == null ? null : Number(v.toFixed(DECIMALS[unit]))

// deno-lint-ignore no-explicit-any
type Body = any

/**
 * An inquire-index-price answer (KOSPI / KOSDAQ). It carries no date, so the caller gives the trading day.
 * prev_close = price − the change, signed by prdy_vrss_sign (1 상한, 2 상승, 3 보합, 4 하한, 5 하락).
 */
export function parseIndex(body: Body, spec: Spec, valueDate: string): Quote | null {
  const o = body?.output
  const price = num(o?.bstp_nmix_prpr)
  if (!price) return null
  const change = num(o?.bstp_nmix_prdy_vrss)
  const sign = String(o?.prdy_vrss_sign ?? '')
  const signed = change == null ? null : sign === '3' ? 0 : (sign === '4' || sign === '5' ? -1 : 1) * Math.abs(change)
  return {
    symbol: spec.symbol, kind: 'index', name: spec.name, price,
    prev_close: round(signed == null ? null : price - signed, 'pt'),
    unit: 'pt', value_date: valueDate, source: 'kis',
  }
}

/**
 * An inquire-daily-chartprice answer (FX, bond yields; also KOSPI there, for the trading day). output1 has the current
 * value and the previous close, output2 the daily bars, newest first. An unknown code answers rt_cd 0 with zeros and
 * no bars: null.
 */
export function parseChart(body: Body, spec: Spec, kind: Kind, unit: Quote['unit']): Quote | null {
  const price = num(body?.output1?.ovrs_nmix_prpr)
  const day = body?.output2?.[0]?.stck_bsop_date
  if (!price || !/^\d{8}$/.test(day ?? '')) return null
  return {
    symbol: spec.symbol, kind, name: spec.name, price: round(price, unit)!,
    prev_close: round(num(body.output1.ovrs_nmix_prdy_clpr) || null, unit),
    unit, value_date: isoDate(day), source: 'kis',
  }
}

/** The newest bar's date in a chart answer (YYYY-MM-DD), or null. */
export function chartDate(body: Body): string | null {
  const day = body?.output2?.[0]?.stck_bsop_date
  return /^\d{8}$/.test(day ?? '') ? isoDate(day) : null
}

/** Whether `t` is inside 09:00–15:40 KST, when KOSPI / KOSDAQ are fetched (the 15:40 run takes the 15:30 close). */
export function inIndexHours(t: Date): boolean {
  const kst = new Date(t.getTime() + 9 * 3600_000)
  const min = kst.getUTCHours() * 60 + kst.getUTCMinutes()
  return min >= 9 * 60 && min <= 15 * 60 + 40
}
