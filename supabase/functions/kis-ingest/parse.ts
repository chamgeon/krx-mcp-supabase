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
 * Problems with a whole-market snapshot, empty when it looks right (checks in ../_shared/validate.ts). `requested` is
 * the size of the stock list asked for; a few codes come back empty (delisted since), many missing means trouble.
 */
export function kisSnapshotProblems(rows: ReturnType<typeof parseKisRows>, requested: number): string[] {
  return rowProblems(rows, { minRows: Math.floor(requested * 0.95) })
}
