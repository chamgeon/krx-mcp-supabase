// Same-day snapshot of every KOSPI + KOSDAQ stock from the KIS (한국투자증권) Open API, stored in
// public.live_prices (source = 'kis'). krx-ingest writes the day's official KRX numbers to daily_prices
// the next morning and clears it from live_prices. Readers use the public.prices view, which combines both.
// Rewriting rows every 5 minutes happens only in the small live_prices table, so daily_prices's indexes don't bloat.
//
// Called by pg_cron (see sql/cron.sql). Protected by the x-ingest-secret header.
//
//   POST /functions/v1/kis-ingest   -> snapshot today (no-op on weekends and holidays)
//
// Runs every 5 minutes during the session and after the close; each run overwrites the day's rows,
// and as_of records when the snapshot was taken.
//
// KIS has no whole-market endpoint, so the stock list comes from the latest stored day, and the
// fields KIS doesn't return (market, 소속부, 상장주식수) are carried forward from it.
// 시가총액 = 종가 × carried-forward 상장주식수, which is how KRX computes it.
//
// The answer carries `timings` (where the run's time went: KIS calls, rate-limit waits, the database write), and the
// same numbers are saved into the running ingest_runs row as the run goes (run.progress), so a run stopped at the
// 150 s limit still shows which phase it was in.
//
// The multprice calls run KIS_CONCURRENCY at a time under KIS_PER_SECOND (./pool.ts): KIS's limit is 20 calls/s per
// app key, shared with the mcp function's live quotes, so most of it is left for those. A request that gets no answer
// at all is retried by kisGet (`timings.network_retries`). The cron jobs call this function
// with `x-region: ap-northeast-2` (sql/cron.example.sql), so it runs in Seoul next to KIS; its few database calls
// cross to the database's region instead. `timings.ran_in` shows where a run ran.

import 'jsr:@supabase/functions-js@2.119.0/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { kisGet, kisToken } from '../_shared/kis.ts'
import { auctionCodes, kisSnapshotProblems, parseKisRows, type Prev } from './parse.ts'
import { monitored, type RunContext } from '../_shared/ops.ts'
import { pacedPool } from './pool.ts'

const MULTI_MAX = 30 // intstock-multprice: up to 30 stocks per call
const PROGRESS_EVERY = 25 // KIS calls between progress saves (~4 per run)
const KIS_CONCURRENCY = 5
const KIS_PER_SECOND = 8 // 10/s drew 4–15 rate-limit answers per run (11-18), each a 1 s retry
const PRE_OPEN_SKIP = 0.5 // more than half the market in the pre-open auction ('B') = not open yet
const HERE_REGION = Deno.env.get('SB_REGION') || null // set by Supabase; unset locally

// Where a run's time goes (ms), for the answer and the running row's progress
type Timings = {
  phase: string
  ran_in: string | null
  token_ms?: number
  latest_day_ms?: number
  stock_list_ms?: number
  stocks?: number
  kis_calls: number
  kis_ms: number // the multprice calls added up, rate-limit waits included
  kis_wall_ms?: number // the multprice phase from first call to last answer (calls overlap)
  kis_slowest_ms: number
  rate_limited: number // EGW00201 answers (each waits 1 s and retries)
  rate_limit_wait_ms: number
  network_retries: number // requests retried after getting no answer (kisGet)
  upsert_ms?: number
}

async function timed<T>(t: Timings, key: 'token_ms' | 'latest_day_ms' | 'stock_list_ms' | 'upsert_ms', work: Promise<T>): Promise<T> {
  const t0 = performance.now()
  try {
    return await work
  } finally {
    t[key] = Math.round(performance.now() - t0)
  }
}

const INGEST_SECRET = Deno.env.get('INGEST_SECRET')!
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

// Today in Korea as YYYYMMDD
function todayKst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}
function toIsoDate(s: string): string {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

// The latest trading day KIS knows of (today once the market has opened; earlier on holidays)
async function latestTradingDay(token: string): Promise<string> {
  const body = await kisGet(token, '/uapi/domestic-stock/v1/quotations/inquire-daily-price', 'FHKST01010400', {
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: '005930',
    FID_PERIOD_DIV_CODE: 'D',
    FID_ORG_ADJ_PRC: '1',
  })
  return body.output?.[0]?.stck_bsop_date ?? ''
}

async function previousDay(beforeIso: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('available_dates')
    .select('bas_dd')
    .lt('bas_dd', beforeIso)
    .order('bas_dd', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return data?.[0]?.bas_dd ?? null
}

async function stocksOf(dayIso: string): Promise<Prev[]> {
  const out: Prev[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('prices') // the previous day may still be KIS-only if KRX hasn't published it
      .select('isu_cd, isu_nm, market, sect_tp_nm, list_shrs')
      .eq('bas_dd', dayIso)
      .order('isu_cd')
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as Prev[]))
    if (!data || data.length < 1000) return out
  }
}

async function snapshot(
  token: string,
  todayIso: string,
  asOf: string,
  prev: Prev[],
  t: Timings,
  run: RunContext,
): Promise<{ rows: number } | { skipped: string }> {
  const byCode = new Map(prev.map((p) => [p.isu_cd, p]))
  const rows: ReturnType<typeof parseKisRows> = []
  const auction = new Map<string, string>() // code → hour_cls_code, for expected prices (./parse.ts)
  const onRateLimited = async (wait: Promise<void>) => {
    const w0 = performance.now()
    t.rate_limited++
    await wait
    t.rate_limit_wait_ms += Math.round(performance.now() - w0)
  }
  t.phase = 'kis_calls'
  const batches: Prev[][] = []
  for (let i = 0; i < prev.length; i += MULTI_MAX) batches.push(prev.slice(i, i + MULTI_MAX))
  const w0 = performance.now()
  const parsed = await pacedPool(batches, { concurrency: KIS_CONCURRENCY, perSecond: KIS_PER_SECOND }, async (batch) => {
    const params: Record<string, string> = {}
    batch.forEach((p, j) => {
      params[`FID_COND_MRKT_DIV_CODE_${j + 1}`] = 'J'
      params[`FID_INPUT_ISCD_${j + 1}`] = p.isu_cd
    })
    const c0 = performance.now()
    const body = await kisGet(token, '/uapi/domestic-stock/v1/quotations/intstock-multprice', 'FHKST11300006', params, {
      onRateLimited,
      onNetworkRetry: () => t.network_retries++,
    })
    const ms = Math.round(performance.now() - c0)
    t.kis_calls++
    t.kis_ms += ms
    t.kis_slowest_ms = Math.max(t.kis_slowest_ms, ms)
    t.kis_wall_ms = Math.round(performance.now() - w0)
    // not awaited: a progress save must not hold up the next call (it's one small update, and the last one wins)
    if (t.kis_calls % PROGRESS_EVERY === 0) run.progress({ ...t })
    for (const [code, hour] of auctionCodes(body.output)) auction.set(code, hour)
    return parseKisRows(body.output, byCode, todayIso, asOf)
  })
  for (const r of parsed) rows.push(...r)
  t.kis_wall_ms = Math.round(performance.now() - w0)
  // Pre-market data isn't kept: during the pre-open auction (08:30–09:00, or 09:30–10:00 on 수능 day and the year's
  // first trading day) KIS already reports today, at expected prices with no trades. Keep the previous snapshot.
  // Expected prices later in the day (VI, the closing auction) are kept, as live prices, outside the range check.
  const preOpen = [...auction.values()].filter((h) => h === 'B').length
  if (preOpen > rows.length * PRE_OPEN_SKIP) {
    t.phase = 'done'
    return { skipped: `pre-open auction (${preOpen} of ${rows.length} stocks)` }
  }
  // Refuse a snapshot that looks wrong (renamed fields, most stocks missing): the previous snapshot stays, with its
  // older as_of, and the run fails with the reason
  const problems = kisSnapshotProblems(rows, prev.length, auction)
  if (problems.length) throw new Error(`refused snapshot: ${problems.join('; ')}`)
  t.phase = 'upsert'
  await run.progress(t)
  await timed(t, 'upsert_ms', (async () => {
    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await supabase
        .from('live_prices')
        .upsert(rows.slice(i, i + 1000), { onConflict: 'bas_dd,isu_cd' })
      if (error) throw new Error(`upsert ${todayIso}: ${error.message}`)
    }
  })())
  t.phase = 'done'
  return { rows: rows.length }
}

// Every run is recorded in ingest_runs, and a failure alerts the operator on Telegram (../_shared/ops.ts)
Deno.serve(monitored('kis-ingest', supabase, async (req, run) => {
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }

  const asOf = new Date().toISOString()
  const today = todayKst()
  const todayIso = toIsoDate(today)
  const t: Timings = { phase: 'start', ran_in: HERE_REGION, kis_calls: 0, kis_ms: 0, kis_slowest_ms: 0, rate_limited: 0, rate_limit_wait_ms: 0, network_retries: 0 }
  try {
    t.phase = 'token'
    const token = await timed(t, 'token_ms', kisToken(supabase))
    t.phase = 'latest_day'
    const latest = await timed(t, 'latest_day_ms', latestTradingDay(token))
    if (latest !== today) {
      return Response.json({ date: today, skipped: `not a trading day (latest is ${latest})` })
    }

    const { data: cur } = await supabase.from('available_dates').select('final').eq('bas_dd', todayIso)
    if (cur?.[0]?.final) return Response.json({ date: today, skipped: 'KRX data already loaded' })

    t.phase = 'stock_list'
    const prev = await previousDay(todayIso)
    if (!prev) throw new Error('no earlier day to take the stock list from')
    const stocks = await timed(t, 'stock_list_ms', stocksOf(prev))
    t.stocks = stocks.length
    await run.progress(t)
    const result = await snapshot(token, todayIso, asOf, stocks, t, run)
    return Response.json({ date: today, as_of: asOf, stock_list_from: prev, ...result, timings: t })
  } catch (e) {
    return Response.json({ date: today, error: (e as Error).message, timings: t }, { status: 500 })
  }
}))
