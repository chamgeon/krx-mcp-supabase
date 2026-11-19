// KRX 일별매매정보 response → daily_prices rows. Pure (no network, database or env), so it can be tested against saved
// real responses (parse_test.ts, fixtures/).

import { rowProblems } from '../_shared/validate.ts'

export type KrxMarket = 'KOSPI' | 'KOSDAQ'

export type PriceRow = {
  bas_dd: string
  isu_cd: string
  isu_nm: string
  market: string
  sect_tp_nm: string | null
  close: number | null
  change: number | null
  fluc_rt: number | null
  open: number | null
  high: number | null
  low: number | null
  volume: number | null
  trdval: number | null
  mktcap: number | null
  list_shrs: number | null
  source: 'krx' | 'kis'
  as_of: string | null
}

// KRX returns every number as a string, often comma-formatted, and "-" for empty.
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/,/g, '').trim()
  if (s === '' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export function toIsoDate(s: string): string {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/** The stock rows of one market's response body. An empty list means a holiday or a day KRX hasn't published yet. */
export function krxItems(body: unknown): Record<string, string>[] {
  const items = (body as { OutBlock_1?: unknown })?.OutBlock_1
  return Array.isArray(items) ? items : []
}

export function parseKrxRows(items: Record<string, string>[], market: KrxMarket, basDd: string): PriceRow[] {
  const rows: PriceRow[] = []
  for (const r of items) {
    if (!r.ISU_CD) continue
    rows.push({
      bas_dd: toIsoDate(basDd),
      isu_cd: r.ISU_CD,
      isu_nm: r.ISU_NM,
      market,
      sect_tp_nm: r.SECT_TP_NM || null,
      close: num(r.TDD_CLSPRC),
      change: num(r.CMPPREVDD_PRC),
      fluc_rt: num(r.FLUC_RT),
      open: num(r.TDD_OPNPRC),
      high: num(r.TDD_HGPRC),
      low: num(r.TDD_LWPRC),
      volume: num(r.ACC_TRDVOL),
      trdval: num(r.ACC_TRDVAL),
      mktcap: num(r.MKTCAP),
      list_shrs: num(r.LIST_SHRS),
      source: 'krx',
      as_of: null,
    })
  }
  return rows
}

/**
 * Problems with one day of KRX data, empty when it looks right (validation in ../_shared/validate.ts). Both markets
 * empty is a holiday or a day not published yet, which is fine; one empty market is not. `prevTotal` is the stock
 * count of the previous stored day: a day with far fewer stocks means rows went missing.
 */
export function krxDayProblems(kospi: PriceRow[], kosdaq: PriceRow[], prevTotal: number | null): string[] {
  if (kospi.length === 0 && kosdaq.length === 0) return []
  const problems: string[] = []
  if (kospi.length === 0) problems.push('KOSPI returned no rows but KOSDAQ did')
  if (kosdaq.length === 0) problems.push('KOSDAQ returned no rows but KOSPI did')
  const minRows = prevTotal ? Math.floor(prevTotal * 0.9) : 2000
  problems.push(...rowProblems([...kospi, ...kosdaq], { minRows, extraNumeric: ['mktcap', 'list_shrs'] }))
  return problems
}
