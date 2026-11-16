// Sanity checks for a batch of price rows (krx-ingest, kis-ingest) before anything is written. A format change upstream
// (a renamed field, a missing block) doesn't throw in the parsers: it turns values into null or rows into nothing. These
// checks turn that into an error, so the ingest refuses the data, keeps what's stored, and fails visibly (HTTP 500).
//
// The thresholds come from real data (krx-ingest/fixtures, 2026-11-13): 2,770 rows, no missing numbers, no
// out-of-order OHLC, no 등락률 beyond ±30%. A few bad rows are tolerated (a listing day can move more than 30%); a
// format change breaks far more than that.

export type CheckedRow = {
  isu_cd: string
  isu_nm: string
  close: number | null
  change: number | null
  fluc_rt: number | null
  open: number | null
  high: number | null
  low: number | null
  volume: number | null
  trdval: number | null
}

const NUMERIC = ['close', 'change', 'fluc_rt', 'open', 'high', 'low', 'volume', 'trdval'] as const
const PRICE_LIMIT = 30.5 // KRX daily limit is ±30%; the extra 0.5 absorbs rounding

/** Problems with a batch of rows, empty when it looks right. `minRows`: fewer rows than this is a problem. */
export function rowProblems(rows: CheckedRow[], opts: { minRows: number; extraNumeric?: string[] }): string[] {
  const problems: string[] = []
  const n = rows.length
  if (n < opts.minRows) problems.push(`only ${n} rows (expected at least ${opts.minRows})`)
  if (n === 0) return problems

  // More than 1% of rows (and more than 5) failing a check means something systematic, not one odd stock
  const tooMany = (bad: number) => bad > Math.max(5, n * 0.01)
  const pct = (bad: number) => `${bad} of ${n} rows`

  const codes = new Set<string>()
  let dup = 0, badCode = 0, noName = 0
  for (const r of rows) {
    if (codes.has(r.isu_cd)) dup++
    codes.add(r.isu_cd)
    if (!/^[0-9A-Z]{6}$/.test(r.isu_cd ?? '')) badCode++
    if (!r.isu_nm?.trim()) noName++
  }
  if (dup) problems.push(`${dup} duplicate 종목코드`)
  if (tooMany(badCode)) problems.push(`종목코드 not 6 letters/digits in ${pct(badCode)}`)
  if (tooMany(noName)) problems.push(`종목명 empty in ${pct(noName)}`)

  for (const field of [...NUMERIC, ...(opts.extraNumeric ?? [])]) {
    const missing = rows.filter((r) => (r as Record<string, unknown>)[field] == null).length
    if (tooMany(missing)) problems.push(`${field} missing in ${pct(missing)}`)
  }

  const priced = rows.filter((r) => r.close != null)
  const nonPositive = priced.filter((r) => r.close! <= 0).length
  if (tooMany(nonPositive)) problems.push(`종가 <= 0 in ${pct(nonPositive)}`)

  // No-trade rows (거래대금 0) carry the last close with open/high/low = 0, so only traded rows have a real range
  const traded = rows.filter((r) => (r.trdval ?? 0) > 0 && r.high != null && r.low != null && r.close != null)
  const outOfRange = traded.filter((r) => r.low! > r.close! || r.close! > r.high! || (r.open != null && r.open > 0 && (r.open < r.low! || r.open > r.high!))).length
  if (tooMany(outOfRange)) problems.push(`open/close outside low..high in ${pct(outOfRange)}`)

  const beyondLimit = rows.filter((r) => r.fluc_rt != null && Math.abs(r.fluc_rt) > PRICE_LIMIT).length
  if (tooMany(beyondLimit)) problems.push(`등락률 beyond ±30% in ${pct(beyondLimit)}`)

  return problems
}
