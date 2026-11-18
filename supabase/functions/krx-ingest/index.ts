// Pulls KOSPI + KOSDAQ 일별매매정보 from the KRX Open API and stores it in public.daily_prices.
//
// Called by pg_cron (see sql/cron.sql). Protected by the x-ingest-secret header.
// Replaces kis-ingest's same-day provisional rows (source = 'kis') with KRX's official numbers.
//
//   POST /functions/v1/krx-ingest                         -> today + any weekday in the last 7 days not yet from KRX
//   POST /functions/v1/krx-ingest?date=20261008           -> (re)load one day
//   POST /functions/v1/krx-ingest?from=20260901&to=20261010 -> backfill a range (weekdays only)
//
// KOSPI and KOSDAQ are fetched in parallel. The cron job calls this function with `x-region: ap-northeast-2`
// (sql/cron.example.sql), so it runs in Seoul next to KRX: a day's two answers are large, and from Mumbai a loading run
// took 126 s (11-18), most of it the KRX calls. The answer carries `timings` per day (each KRX call's time, size and
// rows, the KIS comparison read, the upsert, the cleanup) and `ran_in`; the same goes into the running ingest_runs row
// after each day (run.progress), so a run stopped at the 150 s limit shows how far it got.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { compareKisKrx, type KisCheck, krxDayProblems, krxItems, parseKrxRows, type PriceRow, toIsoDate } from './parse.ts'
import { monitored, type RunContext } from '../_shared/ops.ts'

const KRX_BASE = 'https://data-dbg.krx.co.kr/svc/apis/sto'
const MARKETS = [
  { market: 'KOSPI', path: 'stk_bydd_trd' }, // 유가증권 일별매매정보
  { market: 'KOSDAQ', path: 'ksq_bydd_trd' }, // 코스닥 일별매매정보
] as const

const HERE_REGION = Deno.env.get('SB_REGION') || null // set by Supabase; unset locally
const KRX_API_KEY = Deno.env.get('KRX_API_KEY')!
const INGEST_SECRET = Deno.env.get('INGEST_SECRET')!
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}
function parseYmd(s: string): Date {
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)))
}
function isWeekend(d: Date): boolean {
  const w = d.getUTCDay()
  return w === 0 || w === 6
}
// "Today" in Korea, as a UTC-midnight Date
function todayKst(): Date {
  const kst = new Date(Date.now() + 9 * 3600 * 1000)
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()))
}

// Where a day's time went (ms); `krx` has one entry per market call
type KrxCall = { market: string; ms: number; kb: number; rows: number }
type DayTimings = { krx: KrxCall[]; krx_wall_ms?: number; kis_rows_ms?: number; upsert_ms?: number; cleanup_ms?: number }

const since = (t0: number) => Math.round(performance.now() - t0)

async function fetchMarket(path: string, basDd: string, calls: KrxCall[], market: string): Promise<Record<string, string>[]> {
  const t0 = performance.now()
  const res = await fetch(`${KRX_BASE}/${path}?basDd=${basDd}`, {
    headers: { AUTH_KEY: KRX_API_KEY },
  })
  if (res.status === 429) throw new Error('KRX daily call limit reached (429)')
  const text = await res.text()
  if (!res.ok) throw new Error(`KRX ${path} ${basDd}: HTTP ${res.status} ${text.slice(0, 300)}`)
  const items = krxItems(JSON.parse(text))
  calls.push({ market, ms: since(t0), kb: Math.round(text.length / 1024), rows: items.length })
  return items
}

// KIS's provisional rows for a day (its last snapshot), to compare with KRX's before they're replaced
async function kisRowsOf(dayIso: string): Promise<{ isu_cd: string; close: number | null }[]> {
  const out: { isu_cd: string; close: number | null }[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('live_prices').select('isu_cd, close').eq('bas_dd', dayIso)
      .order('isu_cd').range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

async function ingestDay(basDd: string, t: DayTimings): Promise<{ rows: number; kisCheck: KisCheck | null }> {
  // The two markets are independent: fetched in parallel
  const w0 = performance.now()
  const [kospi, kosdaq]: PriceRow[][] = await Promise.all(
    MARKETS.map(async ({ market, path }) => parseKrxRows(await fetchMarket(path, basDd, t.krx, market), market, basDd)),
  )
  t.krx_wall_ms = since(w0)
  // Refuse data that looks wrong (a renamed field, missing rows) before writing anything: the stored day and the KIS
  // rows stay as they are, and the run fails with the reason
  const problems = krxDayProblems(kospi, kosdaq, await previousDayCount(toIsoDate(basDd)))
  if (problems.length) throw new Error(`refused ${basDd}: ${problems.join('; ')}`)
  const rows = [...kospi, ...kosdaq]
  // Before KRX's numbers replace KIS's, compare them (the report shows the result)
  let t0 = performance.now()
  const kisRows = rows.length ? await kisRowsOf(toIsoDate(basDd)) : []
  if (rows.length) t.kis_rows_ms = since(t0)
  const kisCheck = kisRows.length ? compareKisKrx(kisRows, rows) : null
  // Empty = holiday, or KRX hasn't published that day yet
  t0 = performance.now()
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase
      .from('daily_prices')
      .upsert(rows.slice(i, i + 1000), { onConflict: 'bas_dd,isu_cd' })
    if (error) throw new Error(`upsert ${basDd}: ${error.message}`)
  }
  if (rows.length) t.upsert_ms = since(t0)
  if (rows.length > 0) {
    t0 = performance.now()
    // The day is official now: drop kis-ingest's provisional rows for it. (The prices view already hides
    // them once daily_prices has the day; this just keeps live_prices small.)
    const { error } = await supabase
      .from('live_prices')
      .delete()
      .eq('bas_dd', toIsoDate(basDd))
    if (error) throw new Error(`cleanup ${basDd}: ${error.message}`)
    t.cleanup_ms = since(t0)
  }
  return { rows: rows.length, kisCheck }
}

// Stock count of the latest KRX day before `dayIso` (null when there is none, e.g. the first load)
async function previousDayCount(dayIso: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('available_dates')
    .select('row_count')
    .eq('final', true)
    .lt('bas_dd', dayIso)
    .order('bas_dd', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return data?.[0]?.row_count ?? null
}

// Days whose rows all come from KRX
async function finalDates(fromIso: string, toIso: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('available_dates')
    .select('bas_dd')
    .eq('final', true)
    .gte('bas_dd', fromIso)
    .lte('bas_dd', toIso)
  if (error) throw new Error(error.message)
  return new Set((data ?? []).map((d) => String(d.bas_dd).replace(/-/g, '')))
}

// Every run is recorded in ingest_runs, and a failure alerts the operator on Telegram (../_shared/ops.ts)
Deno.serve(monitored('krx-ingest', supabase, async (req, run: RunContext) => {
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }

  const url = new URL(req.url)
  const date = url.searchParams.get('date')
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')

  let targets: string[] = []
  if (date) {
    targets = [date]
  } else if (from && to) {
    for (let d = parseYmd(from); d <= parseYmd(to); d = new Date(d.getTime() + 86400000)) {
      if (!isWeekend(d)) targets.push(ymd(d))
    }
  } else {
    // Default: any weekday in the last 7 days without KRX data yet (missing, or only KIS's provisional
    // rows), plus today (always re-fetched, so the latest run wins once KRX publishes final numbers)
    const today = todayKst()
    const start = new Date(today.getTime() - 7 * 86400000)
    const have = await finalDates(toIsoDate(ymd(start)), toIsoDate(ymd(today)))
    for (let d = start; d < today; d = new Date(d.getTime() + 86400000)) {
      if (!isWeekend(d) && !have.has(ymd(d))) targets.push(ymd(d))
    }
    if (!isWeekend(today)) targets.push(ymd(today))
  }

  const results: Record<string, number | string> = {}
  const kisCheck: Record<string, KisCheck> = {} // per day: KIS's last snapshot vs. KRX's official closes
  const timings: { ran_in: string | null; days: Record<string, DayTimings> } = { ran_in: HERE_REGION, days: {} }
  for (const t of targets) {
    const dt: DayTimings = { krx: [] }
    timings.days[t] = dt
    try {
      const r = await ingestDay(t, dt)
      results[t] = r.rows
      if (r.kisCheck) kisCheck[t] = r.kisCheck
    } catch (e) {
      results[t] = `error: ${(e as Error).message}`
      if (String(e).includes('429')) break
    }
    await run.progress({ done: Object.keys(results).length, of: targets.length, timings })
  }
  // Non-2xx when any day failed, so the failure shows up in the function logs and net._http_response
  // instead of hiding behind a 200 (a 401 from an expired KRX key went unnoticed for two weeks this way).
  const failed = Object.values(results).some((r) => typeof r === 'string')
  return Response.json({ targets, results, kis_check: kisCheck, timings }, { status: failed ? 500 : 200 })
}))
