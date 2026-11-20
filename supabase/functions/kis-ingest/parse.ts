// KIS 관심종목(멀티종목) 시세 response (intstock-multprice, FHKST11300006) → live_prices rows. Pure, so it can be tested
// against saved real responses (parse_test.ts, fixtures/).
//
// KIS has no whole-market endpoint, so the stock list comes from the latest stored day (`prev`), and the fields KIS
// doesn't return (market, 소속부, 상장주식수) are carried forward from it. 시가총액 = 종가 × carried-forward 상장주식수,
// which is how KRX computes it.

import { num } from '../_shared/kis.ts'
import { rowProblems } from '../_shared/validate.ts'

export type Prev = {
  isu_cd: string
  isu_nm: string
  market: string
  sect_tp_nm: string | null
  list_shrs: number | null
}

export function parseKisRows(
  output: Record<string, string>[] | undefined,
  byCode: Map<string, Prev>,
  todayIso: string,
  asOf: string,
) {
  const rows = []
  for (const r of output ?? []) {
    const p = byCode.get(r.inter_shrn_iscd) // unknown / delisted codes come back as empty rows
    if (!p) continue
    const close = num(r.inter2_prpr)
    rows.push({
      bas_dd: todayIso,
      isu_cd: p.isu_cd,
      isu_nm: r.inter_kor_isnm || p.isu_nm,
      market: p.market,
      sect_tp_nm: p.sect_tp_nm,
      close,
      change: num(r.inter2_prdy_vrss),
      fluc_rt: num(r.prdy_ctrt),
      open: num(r.inter2_oprc),
      high: num(r.inter2_hgpr),
      low: num(r.inter2_lwpr),
      volume: num(r.acml_vol),
      trdval: num(r.acml_tr_pbmn),
      mktcap: close != null && p.list_shrs != null ? close * p.list_shrs : null,
      list_shrs: p.list_shrs,
      source: 'kis' as const,
      as_of: asOf,
    })
  }
  return rows
}

/**
 * Stocks whose price is an expected price from a call auction (예상체결가), not a trade, by KIS's hour_cls_code:
 * '0' 예상체결 없음 (a traded price: the regular session, and the 16:00–20:00 after-market too, whose trades KIS also
 * counts in the day's high/low: fixtures/intstock_multprice_20261119.json, 18:08 KST), 'B' 정규장전 예상체결 (the
 * pre-open auction), 'A' 정규장후 예상체결 (an auction after the regular close, e.g. the closing auction), 'C' 장중
 * 예상체결 (VI). Returns code → hour_cls_code for the codes other than '0'. An expected price can sit outside the
 * day's traded range (before the open there's no range at all), so these rows are left out of the range check.
 */
export function auctionCodes(output: Record<string, string>[] | undefined): Map<string, string> {
  return new Map(
    (output ?? []).filter((r) => r.hour_cls_code && r.hour_cls_code !== '0').map((r) => [r.inter_shrn_iscd, r.hour_cls_code]),
  )
}

/**
 * Problems with a whole-market snapshot, empty when it looks right (checks in ../_shared/validate.ts). `requested` is
 * the size of the stock list asked for; a few codes come back empty (delisted since), many missing means trouble.
 * `auction`: auctionCodes() of the responses, left out of the range check.
 */
export function kisSnapshotProblems(rows: ReturnType<typeof parseKisRows>, requested: number, auction?: Map<string, string>): string[] {
  return rowProblems(rows, { minRows: Math.floor(requested * 0.95), auction: auction && new Set(auction.keys()) })
}
