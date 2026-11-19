// MCP server for the daily KR-stock movers report.
// Reads from Postgres (filled by kis-ingest / krx-ingest). The only outside call is a live KIS quote for one
// stock in analyze_stock during the session.
//
// Self-hosted, for its operator and a small closed group: OAuth login, and only allowlisted accounts (see "Auth" at
// the bottom). URL to give ChatGPT / Claude:
//   https://<project-ref>.supabase.co/functions/v1/mcp
// The operator's key for scripts and benchmarks (no login; keep it private):
//   https://<project-ref>.supabase.co/functions/v1/mcp?key=<MCP_ACCESS_KEY>

import 'jsr:@supabase/functions-js@2.119.0/edge-runtime.d.ts'
import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@2.4.0'
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { z } from 'npm:zod@4.6.7'
import { createRemoteJWKSet, jwtVerify } from 'npm:jose@5.10.0'
import { isAllowed, parseAllowed } from './allow.ts'
import {
  forgetKisToken,
  isTokenRejected,
  isUsable,
  kisGet,
  kisToken,
  num,
  sessionElapsed,
  storedKisToken,
  type StoredToken,
} from '../_shared/kis.ts'
import { registerTelegramTools } from './telegram.ts'
import { early, type Step, step, timeCall } from './timing.ts'
import {
  arrivalHeaders,
  clientOf,
  forwardHeaders,
  forwardUrl,
  type Hop,
  hopFrom,
  needsDbRegion,
  responseHeaders,
  shouldForward,
} from './forward.ts'
import {
  analyze,
  charts,
  EOK,
  eok,
  kstTime,
  normDate,
  present,
  type Row,
  todayKstIso,
} from './analyze.ts'

const MCP_ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY')!
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

// Report rules (Sheet 1 / Sheet 2)
const SHEET1_MIN_RATE = 15 // 등락률 +15% 이상
const SHEET2_MIN_RATE = 7 // 등락률 +7% 이상
const SHEET2_MIN_TRDVAL = 50_000_000_000 // 거래대금 500억원 이상

// One row of available_dates. It carries the day's status, so the status never needs a query of its own: tools read
// it with the latest day, or fetch it in parallel with their main query.
type DayRow = { bas_dd: string; final: boolean | null; as_of: string | null }
const DAY_COLUMNS = 'bas_dd, final, as_of'

async function dayRow(day: string): Promise<DayRow | null> {
  const { data, error } = await step('data_status', supabase.from('available_dates').select(DAY_COLUMNS).eq('bas_dd', day))
  if (error) throw new Error(error.message)
  return (data?.[0] as DayRow | undefined) ?? null
}

// The latest day with data, with its status (available_dates holds the same days as prices)
async function latestDayRow(): Promise<DayRow | null> {
  const { data, error } = await step('latest_date', supabase
    .from('available_dates')
    .select(DAY_COLUMNS)
    .order('bas_dd', { ascending: false })
    .limit(1))
  if (error) throw new Error(error.message)
  return (data?.[0] as DayRow | undefined) ?? null
}

async function latestDate(): Promise<string | null> {
  return (await latestDayRow())?.bas_dd ?? null
}

// Days that are still provisional (KIS rows not yet replaced by KRX); usually one. Every other day is final, so this
// gives any day's status without knowing the day first.
async function provisionalDays(): Promise<DayRow[]> {
  const { data, error } = await step('provisional_days', supabase.from('available_dates').select(DAY_COLUMNS).eq('final', false))
  if (error) throw new Error(error.message)
  return (data ?? []) as DayRow[]
}

const NO_DATA_FOR_DATE = 'No data for this date. It may be a holiday/weekend, or the day has not closed yet ' +
  '(data appears from ~09:05 KST). Call check_available_dates.'

// Same-day rows come from KIS snapshots (every 5 minutes during the session) and are provisional until KRX's
// official data replaces them the next morning
function dataStatus(d: Pick<DayRow, 'final' | 'as_of'> | null | undefined) {
  if (!d || d.final !== false) return { data_status: '확정치 (KRX official)' }
  const status = {
    data_status: '잠정치 (provisional)',
    as_of: d.as_of ? kstTime(d.as_of) : null,
    data_note:
      'Same-day KIS snapshot. KRX official data replaces it the next morning (~08:00 KST); ' +
      '거래량/거래대금 may rise slightly (after-hours trading), and 시가총액 uses the previous day\'s 상장주식수.',
  }
  const elapsed = d.as_of ? sessionElapsed(new Date(d.as_of)) : 1
  if (elapsed >= 1) return status
  return {
    ...status,
    data_status: '장중 (intraday, provisional)',
    session_elapsed: Math.round(elapsed * 100) / 100,
    intraday_warning:
      `Snapshot taken mid-session (${Math.round(elapsed * 100)}% of 09:00–15:30 elapsed). Today's 거래량/거래대금 are ` +
      'partial, so ratios against prior full-day averages (trdval_ratio, volume_ratio, spikes) are understated, and ' +
      'today\'s high/low/close can still change. For a rough full-day pace, divide those ratios by session_elapsed.',
  }
}

// Live quote for one stock (KIS 주식현재가 시세), used by analyze_stock while the market is open. `stored` is the
// token lookup (memory or Postgres) the caller started early; a new token is issued only if it found none.
async function liveQuote(code: string, stored: Promise<StoredToken | null>) {
  const fetchQuote = (token: string) =>
    step('kis_quote', kisGet(token, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
    }, {
      // a wait after KIS's per-second limit (shared with kis-ingest) shows as its own step inside kis_quote
      onRateLimited: (wait) => step('kis_rate_limited', wait),
    }))
  const s = await stored
  const token = isUsable(s) ? s.access_token : await step('kis_token_issue', kisToken(supabase, stored))
  let body
  try {
    body = await fetchQuote(token)
  } catch (e) {
    // The in-memory token can be stale if another function replaced it: re-read Postgres once, and retry only with a
    // different token (never issue here, which KIS rate-limits)
    if (!isTokenRejected(e)) throw e
    forgetKisToken()
    const fresh = await step('kis_token_retry', storedKisToken(supabase))
    if (!fresh || fresh.access_token === token) throw e
    body = await fetchQuote(fresh.access_token)
  }
  const o = body.output
  return {
    as_of: kstTime(new Date().toISOString()),
    price: num(o.stck_prpr),
    change: num(o.prdy_vrss),
    fluc_rt: num(o.prdy_ctrt),
    open: num(o.stck_oprc),
    high: num(o.stck_hgpr),
    low: num(o.stck_lwpr),
    volume: num(o.acml_vol),
    trdval_eok: eok(num(o.acml_tr_pbmn)),
    mktcap_eok: num(o.hts_avls),
    vs_prev_day_volume_pct: num(o.prdy_vrss_vol_rate),
  }
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}

// Usage logging: every tool call becomes one row in public.tool_calls. The insert runs after the response
// (EdgeRuntime.waitUntil), so logging never slows a tool down, and a failed insert never breaks one.
// hop: where the request landed and the forward time, when it was forwarded here (forward.ts)
type Caller = {
  userId: string | null
  auth: 'oauth' | 'shared_key'
  client: string | null
  hop: Hop
}

// The region this copy runs in (set by Supabase; unset locally)
const HERE_REGION = Deno.env.get('SB_REGION') || null

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

function logCall(
  caller: Caller,
  tool: string,
  args: unknown,
  started: number,
  steps: Step[],
  result: unknown,
  err?: unknown,
) {
  const r = result as { isError?: boolean; content?: { text?: string }[] } | undefined
  const errorText = err
    ? String((err as Error)?.message ?? err)
    : r?.isError
    ? r.content?.map((c) => c.text ?? '').join(' ').slice(0, 1000)
    : null
  const row = {
    user_id: caller.userId,
    auth: caller.auth,
    client: caller.client?.slice(0, 200) ?? null,
    tool,
    args: args ?? null,
    ok: errorText == null,
    error: errorText,
    latency_ms: Math.round(performance.now() - started),
    response_bytes: r?.content ? r.content.reduce((n, c) => n + (c.text?.length ?? 0), 0) : null,
    timings: steps.length ? steps : null,
    landed_in: caller.hop.landedIn,
    forward_ms: caller.hop.forwardMs,
    handled_in: HERE_REGION,
  }
  const p = supabase.from('tool_calls').insert(row).then(({ error }) => {
    if (error) console.error('tool_calls insert failed:', error.message)
  })
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(Promise.resolve(p))
}

// Benchmark calls (scripts/bench.ts): the shared key plus a krx-bench/ User-Agent. They aren't logged, so tool_calls
// holds real usage only; instead the result carries the same latency_ms in _meta (ignored by MCP clients) for the
// benchmark to read. A logged-in user is never treated as a benchmark.
function isBenchmark(caller: Caller): boolean {
  return caller.auth === 'shared_key' && (caller.client?.startsWith('krx-bench/') ?? false)
}

// Wraps server.registerTool so every handler registered on this server is logged (or timed, for benchmarks).
function withLogging(server: McpServer, caller: Caller): McpServer {
  const bench = isBenchmark(caller)
  // deno-lint-ignore no-explicit-any
  const register = server.registerTool.bind(server) as (...a: any[]) => any
  // deno-lint-ignore no-explicit-any
  ;(server as any).registerTool = (name: string, config: any, cb: (...a: any[]) => Promise<unknown>) =>
    // deno-lint-ignore no-explicit-any
    register(name, config, async (...a: any[]) => {
      // Tools without an inputSchema are called with (ctx) only; the rest with (args, ctx).
      const args = config?.inputSchema ? a[0] : null
      const started = performance.now()
      // Each call runs in its own timing context: step() calls below it record into this call's list
      const run = await timeCall(() => cb(...a))
      if (!run.ok) {
        if (!bench) logCall(caller, name, args, started, run.steps, undefined, run.error)
        throw run.error
      }
      if (bench) {
        const r = run.result as { _meta?: Record<string, unknown> }
        return {
          ...r,
          _meta: {
            ...r._meta,
            latency_ms: Math.round(performance.now() - started),
            timings: run.steps,
            hop: { ...caller.hop, handledIn: HERE_REGION },
          },
        }
      }
      logCall(caller, name, args, started, run.steps, run.result)
      return run.result
    })
  return server
}

const handler = createMcpHandler((ctx) => {
  const caller: Caller = {
    userId: (ctx.authInfo?.extra?.userId as string | undefined) ?? null,
    auth: ctx.authInfo?.extra?.userId ? 'oauth' : 'shared_key',
    // The caller's User-Agent; for a forwarded request, as the landing copy saw it (forward.ts, clientOf)
    client: clientOf(ctx.requestInfo?.headers),
    // Set by Deno.serve below (arrivalHeaders), never taken from the caller as sent
    hop: hopFrom(ctx.requestInfo?.headers),
  }
  const server = withLogging(new McpServer({ name: 'kr-stock-movers', version: '0.1.0' }), caller)

  server.registerTool(
    'get_daily_movers',
    {
      title: '국내 급등 종목 (Sheet 1 / Sheet 2 / Sheet 3)',
      description:
        'Returns the Korean stock (KOSPI+KOSDAQ) daily movers report for one trading day, already split into sheets: ' +
        `sheet1 = 등락률 >= +${SHEET1_MIN_RATE}%; ` +
        `sheet2 = 등락률 >= +${SHEET2_MIN_RATE}% AND 거래대금 >= 500억원, excluding sheet1 stocks; ` +
        'both sorted by 등락률 descending. sheet3 = 일봉/주봉/월봉 chart URLs for every stock in sheet1 and sheet2. ' +
        'During the session (from 09:05 KST) the current day is a KIS snapshot refreshed every 5 minutes ' +
        '(data_status = 장중, see as_of); after the close it is the provisional end-of-day snapshot (잠정치), ' +
        'replaced by KRX official data the next morning (~08:00 KST). ' +
        'Omit date to get the latest available trading day. This tool has no news — search the web for why each stock rose.',
      inputSchema: z.object({
        date: z
          .string()
          .regex(/^\d{4}-?\d{2}-?\d{2}$/)
          .optional()
          .describe('Trading day, YYYY-MM-DD or YYYYMMDD. Omit for the latest available day.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => {
      const movers = (day: string) =>
        step('movers', supabase
          .from('prices')
          .select('*')
          .eq('bas_dd', day)
          .gte('fluc_rt', SHEET2_MIN_RATE)
          .order('fluc_rt', { ascending: false }))

      // With a date, its status row and the movers are fetched together; without one, the latest row is the status
      let day: string
      let status: DayRow | null
      let res: Awaited<ReturnType<typeof movers>>
      if (date) {
        day = normDate(date)
        ;[status, res] = await Promise.all([dayRow(day), movers(day)])
      } else {
        status = await latestDayRow()
        if (!status) return json({ error: 'No data ingested yet.' })
        day = status.bas_dd
        res = await movers(day)
      }
      if (res.error) throw new Error(res.error.message)

      // available_dates has a row for every day with data, so no row means no data
      if (!status) return json({ date: day, error: NO_DATA_FOR_DATE })
      const rows = (res.data ?? []) as Row[]

      const sheet1 = rows.filter((r) => (r.fluc_rt ?? 0) >= SHEET1_MIN_RATE)
      const sheet2 = rows.filter(
        (r) => (r.fluc_rt ?? 0) < SHEET1_MIN_RATE && (r.trdval ?? 0) >= SHEET2_MIN_TRDVAL,
      )
      const sheet3 = [...sheet1, ...sheet2].map((r) => ({
        종목코드: r.isu_cd,
        종목명: r.isu_nm,
        ...charts(r.isu_cd),
      }))

      return json({
        date: day,
        ...dataStatus(status),
        rules: {
          sheet1: `등락률 >= +${SHEET1_MIN_RATE}%`,
          sheet2: `등락률 >= +${SHEET2_MIN_RATE}% AND 거래대금 >= 500억원, sheet1 제외`,
          sort: '등락률 내림차순',
        },
        sheet1_count: sheet1.length,
        sheet2_count: sheet2.length,
        sheet1: sheet1.map(present),
        sheet2: sheet2.map(present),
        sheet3_charts: sheet3,
      })
    },
  )

  server.registerTool(
    'get_stock_history',
    {
      title: '종목 최근 일별 시세',
      description:
        'Recent daily OHLCV, 등락률 and 거래대금 for one stock (most recent first). ' +
        'Useful context for explaining a move, e.g. whether it was a breakout after a long base or a multi-day run.',
      inputSchema: z.object({
        code: z.string().describe('6-digit 종목코드, e.g. 005930'),
        // 120 (~6 months, screen_stocks' longest window): 250 rows came to 66 KB, over the 64 KB limit (SIZE-2)
        days: z.number().int().min(1).max(120).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ code, days }) => {
      const { data, error } = await step('history', supabase
        .from('prices')
        .select('*')
        .eq('isu_cd', code)
        .order('bas_dd', { ascending: false })
        .limit(days))
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as Row[]
      // The stock's fields once, from the latest row; each row is the date and the day's numbers
      return json({
        종목코드: code,
        종목명: rows[0]?.isu_nm ?? null,
        시장: rows[0]?.market ?? null,
        소속부: rows[0]?.sect_tp_nm ?? null,
        rows: rows.map((r) => {
          const { 종목코드: _c, 종목명: _n, 시장: _m, 소속부: _s, ...day } = present(r)
          return { 일자: r.bas_dd, ...day }
        }),
        charts: charts(code),
      })
    },
  )

  server.registerTool(
    'screen_stocks',
    {
      title: '전 종목 조건 검색',
      description:
        'Screens every KOSPI/KOSDAQ stock on one trading day with optional quantitative filters (omit a filter to turn it off). ' +
        'All metrics are computed in SQL from stored end-of-day data; windows count trading days. Every row returns all metrics, ' +
        'whichever filters were used: trdval_ratio = 거래대금 / prior avg_days average; volume_ratio = 거래량 / prior avg_days ' +
        'average (거래량 = shares traded, 거래대금 = won traded); trdval_up_days / price_up_days = consecutive ' +
        'daily increases ending on the date; volatility = stddev of daily 등락률 (%) over volatility_days; sideways_range_pct = ' +
        '(highest high - lowest low) / lowest low over sideways_days; sideways_trdval_growth = avg 거래대금 of the last ' +
        'sideways_recent_days / avg of the rest of the box; breakout_N = close > highest high of the prior N days (null if the stock ' +
        'has too little history). high_60/high_120/breakout_60/breakout_120 are only computed, and only returned, when breakout_days ' +
        'lists 60 or 120; to find 60/120-day breakouts pass e.g. {breakout_days: [60]}. The database holds about a year of history. ' +
        'Streaks are counted within the last ~20 trading days. ' +
        'Examples: 거래량 >= 3x prior 5-day average = {avg_days: 5, min_volume_ratio: 3}; ' +
        'box + rising 거래대금 = {max_sideways_range: 15, min_sideways_trdval_growth: 2}.',
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-?\d{2}-?\d{2}$/).optional().describe('YYYY-MM-DD or YYYYMMDD. Omit for the latest day.'),
        market: z.enum(['KOSPI', 'KOSDAQ']).optional(),
        include_untraded: z
          .boolean()
          .default(false)
          .describe('Include stocks with 거래대금 = 0 on the date (trading halt or no trades). Off by default.'),
        min_fluc_rt: z.number().optional().describe('등락률 % >='),
        max_fluc_rt: z.number().optional().describe('등락률 % <='),
        min_trdval_eok: z.number().optional().describe('거래대금 (억원) >='),
        min_mktcap_eok: z.number().optional().describe('시가총액 (억원) >='),
        avg_days: z.number().int().min(1).max(120).default(20).describe('Prior-day window for the 거래대금 and 거래량 averages'),
        min_trdval_ratio: z.number().optional().describe('거래대금 / prior avg_days average >= (e.g. 3)'),
        min_volume: z.number().int().optional().describe('거래량 (shares) >='),
        min_volume_ratio: z.number().optional().describe('거래량 / prior avg_days average >= (e.g. 3)'),
        min_trdval_up_days: z.number().int().min(1).optional().describe('거래대금 increased at least this many days in a row'),
        sideways_days: z.number().int().min(5).max(120).default(20),
        sideways_recent_days: z.number().int().min(1).max(60).default(5),
        max_sideways_range: z.number().optional().describe('Box high/low range % <= (e.g. 15)'),
        min_sideways_trdval_growth: z.number().optional().describe('Recent / earlier 거래대금 inside the box >= (e.g. 1.5)'),
        breakout_days: z
          .array(z.union([z.literal(20), z.literal(60), z.literal(120)]))
          .optional()
          .describe('Require close > prior N-day high for every N listed'),
        min_price_up_days: z.number().int().min(1).optional().describe('Closed higher at least this many days in a row'),
        volatility_days: z.number().int().min(2).max(120).default(20),
        min_volatility: z.number().optional(),
        max_volatility: z.number().optional(),
        sort: z
          .enum([
            'fluc_rt', 'trdval', 'trdval_ratio', 'volume', 'volume_ratio', 'trdval_up_days', 'price_up_days',
            'volatility', 'sideways_range_pct', 'sideways_trdval_growth', 'mktcap',
          ])
          .default('fluc_rt')
          .describe('Descending, except sideways_range_pct (tightest box first)'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      if (a.sideways_recent_days >= a.sideways_days) {
        return json({ error: 'sideways_recent_days must be smaller than sideways_days.' })
      }
      // As in get_daily_movers: the latest row carries the status, or a given date's row is fetched alongside
      const latest = a.date ? null : await latestDayRow()
      const day = a.date ? normDate(a.date) : latest?.bas_dd
      if (!day) return json({ error: 'No data ingested yet.' })

      const [status, { data, error }] = await Promise.all([latest ?? dayRow(day), step('screen_stocks_rpc', supabase.rpc('screen_stocks', {
        p_date: day,
        p_market: a.market ?? null,
        p_include_untraded: a.include_untraded,
        p_min_fluc_rt: a.min_fluc_rt ?? null,
        p_max_fluc_rt: a.max_fluc_rt ?? null,
        p_min_trdval: a.min_trdval_eok == null ? null : Math.round(a.min_trdval_eok * EOK),
        p_min_mktcap: a.min_mktcap_eok == null ? null : Math.round(a.min_mktcap_eok * EOK),
        p_avg_days: a.avg_days,
        p_min_trdval_ratio: a.min_trdval_ratio ?? null,
        p_min_volume: a.min_volume ?? null,
        p_min_volume_ratio: a.min_volume_ratio ?? null,
        p_min_trdval_up_days: a.min_trdval_up_days ?? null,
        p_sideways_days: a.sideways_days,
        p_sideways_recent_days: a.sideways_recent_days,
        p_max_sideways_range: a.max_sideways_range ?? null,
        p_min_sideways_trdval_growth: a.min_sideways_trdval_growth ?? null,
        p_breakout_days: a.breakout_days ?? null,
        p_min_price_up_days: a.min_price_up_days ?? null,
        p_volatility_days: a.volatility_days,
        p_min_volatility: a.min_volatility ?? null,
        p_max_volatility: a.max_volatility ?? null,
        p_sort: a.sort,
        p_limit: a.limit,
      }))])
      if (error) throw new Error(error.message)
      // A holiday/weekend used to return 0 stocks marked 확정치; no status row means the day has no data
      if (!status) return json({ date: day, error: NO_DATA_FOR_DATE })

      const rows = (data ?? []) as Record<string, any>[]
      const { date: _d, limit: _l, ...filters } = a
      // The 60/120-day highs are skipped in SQL unless asked for; leave the keys out rather than return nulls
      // that read as missing history
      const with60 = a.breakout_days?.some((n) => n >= 60) ?? false
      const with120 = a.breakout_days?.includes(120) ?? false
      return json({
        date: day,
        ...dataStatus(status),
        filters,
        notes: [
          ...(with120 ? [] : [
            `${with60 ? '120' : '60/120'}-day highs and breakouts were not computed (only when breakout_days lists them, ` +
              'e.g. breakout_days: [60] or [120]). This is not missing data: about a year of history is stored.',
          ]),
          'window_days = rows in the ~20-trading-day calculation window (capped), not the total history stored.',
        ],
        count: rows.length,
        truncated: rows.length === a.limit,
        stocks: rows.map((r) => ({
          code: r.isu_cd,
          name: r.isu_nm,
          market: r.market,
          close: r.close,
          fluc_rt: r.fluc_rt,
          trdval_eok: eok(r.trdval),
          mktcap_eok: eok(r.mktcap),
          trdval_avg_eok: eok(r.trdval_avg),
          trdval_ratio: r.trdval_ratio,
          volume: r.volume,
          volume_avg: r.volume_avg,
          volume_ratio: r.volume_ratio,
          trdval_up_days: r.trdval_up_days,
          price_up_days: r.price_up_days,
          price_down_days: r.price_down_days,
          volatility: r.volatility,
          sideways_range_pct: r.sideways_range_pct,
          sideways_trdval_growth: r.sideways_trdval_growth,
          breakout_20: r.breakout_20,
          high_20: r.high_20,
          ...(with60 ? { breakout_60: r.breakout_60, high_60: r.high_60 } : {}),
          ...(with120 ? { breakout_120: r.breakout_120, high_120: r.high_120 } : {}),
          window_days: r.history_days,
        })),
      })
    },
  )

  server.registerTool(
    'analyze_stock',
    {
      title: '종목 정량 분석',
      description:
        'Quantitative analysis of one stock as of a date, computed from stored daily data (no news, no LLM): returns over ' +
        '1/5/10/20/60/120 days, 거래대금 and 거래량 vs prior averages, recent 거래대금 spikes, MA5/20/60/120 with alignment and 5/20 crosses, ' +
        '20/60/120-day breakouts (close > prior N-day high), volatility (stddev of 등락률, ATR14), up/down streaks, ' +
        'consolidation box and price vs trading value divergence, plus a list of triggered signals. ' +
        'Metrics needing more history than is loaded are null. For new listings (SHORT_HISTORY signal), averages and ' +
        'ratios use the prior days that exist (avg_prior_days), and N-day breakouts stay null until N prior days exist. ' +
        'While the market is open (09:00–15:30 KST) it also returns live_quote, a real-time KIS quote; ' +
        'the analysis itself uses the latest 5-minute snapshot (see as_of).',
      inputSchema: z.object({
        stock: z.string().min(1).describe('6-character 종목코드 (e.g. 005930) or exact/partial 종목명'),
        date: z.string().regex(/^\d{4}-?\d{2}-?\d{2}$/).optional().describe('Analysis date. Omit for the latest day.'),
        avg_days: z.number().int().min(1).max(120).default(20),
        spike_ratio: z.number().min(1).default(2).describe('A day is a spike when 거래대금 (or 거래량) >= this × prior avg_days average'),
        sideways_days: z.number().int().min(6).max(120).default(20),
        sideways_max_range: z.number().default(15).describe('Box range % at or below which the stock counts as consolidating'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ stock, date, ...opts }) => {
      let code = stock.trim()
      if (!/^[0-9A-Z]{6}$/i.test(code)) {
        const day = await latestDate()
        const { data, error } = await step('find_name', supabase
          .from('prices')
          .select('isu_cd, isu_nm, market')
          .eq('bas_dd', day)
          .ilike('isu_nm', `%${code}%`)
          .limit(20))
        if (error) throw new Error(error.message)
        const exact = (data ?? []).find((r) => r.isu_nm === code)
        if (exact) code = exact.isu_cd
        else if (data?.length === 1) code = data[0].isu_cd
        else return json({ error: data?.length ? 'Ambiguous name; pass a 종목코드.' : 'No stock found.', candidates: data })
      }
      code = code.toUpperCase()
      const day = date ? normDate(date) : null

      // The status comes from the provisional days, fetched alongside the history, since the analysed day (the
      // stock's latest row) isn't known until the history arrives.
      const provisionalP = provisionalDays()

      // The live quote is only shown when the analysed day is today during the session. It starts as soon as the
      // provisional days show that today has a snapshot (every listed stock then has a row for today), so it runs
      // alongside the rest of the history query. If the stock's latest row is older after all (e.g. a delisted
      // code), the quote is not used. Without today's snapshot (before 09:05, holidays, tests) KIS is never called.
      const elapsed = sessionElapsed(new Date())
      const today = todayKstIso()
      const mayQuote = elapsed > 0 && elapsed < 1 && (!day || day >= today)
      // The token lookup (memory, else one Postgres read; never KIS) also starts now, so the quote waits only for the
      // provisional days. A new token is issued only once the quote is known to be needed.
      const storedToken = mayQuote ? early(step('kis_token', storedKisToken(supabase))) : null
      const quote = storedToken
        ? provisionalP.then(
          (p) =>
            p.some((d) => d.bas_dd === today)
              ? liveQuote(code, storedToken).then((v) => ({ q: v }), (e: Error) => ({ e }))
              : null,
          () => null, // the failure is reported by the Promise.all below
        )
        : null

      let q = supabase.from('prices').select('*').eq('isu_cd', code)
      if (day) q = q.lte('bas_dd', day)
      const [{ data, error }, provisional] = await Promise.all([
        step('history', q.order('bas_dd', { ascending: false }).limit(250)),
        provisionalP,
      ])
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as Row[]
      if (rows.length === 0) return json({ error: `No data for ${code}${day ? ` on or before ${day}` : ''}.` })
      const result: Record<string, unknown> = {
        ...analyze(rows, opts),
        ...dataStatus(provisional.find((p) => p.bas_dd === rows[0].bas_dd)),
      }
      const r = quote && rows[0].bas_dd === today ? await quote : null
      if (r && 'q' in r) result.live_quote = r.q
      else if (r) result.live_quote_error = r.e.message
      return json(day && result.date !== day ? { note: `No row on ${day}; using ${result.date}.`, ...result } : result)
    },
  )

  server.registerTool(
    'find_stock',
    {
      title: '종목 검색',
      description: 'Find 종목코드 by (partial) Korean stock name.',
      inputSchema: z.object({ name: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => {
      const day = await latestDate()
      const { data, error } = await step('find_name', supabase
        .from('prices')
        .select('isu_cd, isu_nm, market')
        .eq('bas_dd', day)
        .ilike('isu_nm', `%${name}%`)
        .limit(20))
      if (error) throw new Error(error.message)
      return json(data ?? [])
    },
  )

  server.registerTool(
    'check_available_dates',
    {
      title: '거래일 데이터 확인',
      description:
        'Without a date: the range of trading days in the database (total_days, first, last) and the status of the ' +
        'latest day. With a date: whether that day has data, whether it is final (KRX official) or provisional (same-day ' +
        'KIS snapshot, replaced by KRX the next morning), and, if the day has no data (weekend, holiday, not loaded), the ' +
        'nearest trading days before and after it. Use it to resolve "today" / "yesterday" or check a holiday.',
      inputSchema: z.object({
        date: z.string().optional().describe('YYYY-MM-DD or YYYYMMDD; omit for the overall range'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ date }) => {
      // Rows carry final / as_of, so the status needs no query of its own
      const dates = () => supabase.from('available_dates').select('bas_dd, row_count, final, as_of')

      if (date) {
        const day = normDate(date)
        const [hit, prev, next] = await Promise.all([
          step('date_hit', dates().eq('bas_dd', day)),
          step('date_prev', dates().lt('bas_dd', day).order('bas_dd', { ascending: false }).limit(1)),
          step('date_next', dates().gt('bas_dd', day).order('bas_dd', { ascending: true }).limit(1)),
        ])
        for (const r of [hit, prev, next]) if (r.error) throw new Error(r.error.message)
        if (hit.data?.length) {
          return json({ date: day, available: true, stocks: hit.data[0].row_count, ...dataStatus(hit.data[0]) })
        }
        return json({
          date: day,
          available: false,
          note: 'No data for this day: a weekend or holiday, outside the loaded range, or today before ~09:05 KST.',
          previous_trading_day: prev.data?.[0]?.bas_dd ?? null,
          next_trading_day: next.data?.[0]?.bas_dd ?? null,
        })
      }

      const [all, first, last] = await Promise.all([
        step('dates_count', supabase.from('available_dates').select('*', { count: 'exact', head: true })),
        step('dates_first', dates().order('bas_dd', { ascending: true }).limit(1)),
        step('dates_last', dates().order('bas_dd', { ascending: false }).limit(1)),
      ])
      for (const r of [all, first, last]) if (r.error) throw new Error(r.error.message)
      const lastRow = last.data?.[0]
      return json({
        total_days: all.count ?? 0,
        first: first.data?.[0]?.bas_dd ?? null,
        last: lastRow?.bas_dd ?? null,
        ...(lastRow ? dataStatus(lastRow) : {}),
      })
    },
  )

  registerTelegramTools(server, supabase, caller.userId)

  return server
})

// ---- Auth ----
// MCP clients (ChatGPT, Claude) log in with OAuth 2.1, and Supabase Auth is the authorization server:
//   1. A request without a valid token gets a 401 whose WWW-Authenticate header points to the protected resource
//      metadata below.
//   2. The metadata names Supabase Auth as the authorization server; the client registers itself there
//      (dynamic client registration) and sends the user through login + the consent page (web/oauth/consent.html).
//   3. The client calls this function with "Authorization: Bearer <access token>", a Supabase user JWT. We verify it
//      locally against the project's public keys (ES256 JWKS), so no Auth API call per request.
//   4. Only allowlisted accounts get in (ALLOWED_USERS: user ids or emails, comma-separated). This is a self-hosted
//      deployment for its operator and a small closed group, not a public service: a valid login alone isn't enough.
//      Unset or empty = nobody (fails closed), so set the secret before deploying.
// The operator's key (?key=MCP_ACCESS_KEY) skips login: for the operator's own scripts (scripts/bench.ts), logged as
// auth = 'shared_key'. Keep it private like a password.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
// The URL clients see, used as the token issuer and in the metadata. Same as SUPABASE_URL in production; only the
// local stack differs (functions reach Supabase at http://kong:8000, tokens are issued for http://127.0.0.1:54321),
// so tests set PUBLIC_SUPABASE_URL (supabase/tests/functions.env).
const PUBLIC_URL = Deno.env.get('PUBLIC_SUPABASE_URL') ?? SUPABASE_URL
const AUTH_ISSUER = `${PUBLIC_URL}/auth/v1`
const MCP_URL = `${PUBLIC_URL}/functions/v1/mcp`
const RESOURCE_METADATA_URL = `${MCP_URL}/.well-known/oauth-protected-resource`
const jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
const ALLOWED_USERS = parseAllowed(Deno.env.get('ALLOWED_USERS'))
if (!ALLOWED_USERS.size) console.error('ALLOWED_USERS is not set: every login will be refused')

function forbidden(): Response {
  return Response.json({
    error: 'forbidden',
    // Shown to someone who signed in but isn't on ALLOWED_USERS: a private setup, not a judgement on them
    error_description: 'This is a private, invite-only server, and access is set up per account. If someone shared ' +
      'it with you, please ask them to add this account.',
  }, { status: 403 })
}
// The only scope we ask for: a refresh token, so users don't log in again when the ~1 h access token expires.
// Without this hint clients request everything Supabase supports (openid profile email phone ...), none of which
// the server reads; the access token alone identifies the user.
const SCOPES = ['offline_access']

function unauthorized(reason: string): Response {
  return new Response(JSON.stringify({ error: 'unauthorized', error_description: reason }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${RESOURCE_METADATA_URL}", scope="${SCOPES.join(' ')}"`,
    },
  })
}

// Region of the database; requests landing elsewhere are forwarded there (forward.ts). Unset locally and in tests.
const DB_REGION = Deno.env.get('DB_REGION') || undefined

// Answers a request in this instance. The response says where (x-mcp-handled-in), as forwarded answers already do.
async function handleHere(req: Request): Promise<Response> {
  const res = await handle(req)
  if (!HERE_REGION) return res
  const headers = new Headers(res.headers)
  headers.set('x-mcp-handled-in', HERE_REGION)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

Deno.serve(async (req) => {
  const arrivedAt = Date.now()
  if (!shouldForward(DB_REGION, HERE_REGION ?? undefined, req.headers)) {
    // Handled here: record the hop from the landing copy if this was forwarded (forward_ms in tool_calls)
    return handleHere(new Request(req, { headers: arrivalHeaders(req.headers, arrivedAt) }))
  }

  // Buffered (MCP requests are small JSON), so the same body can still be handled here if forwarding fails
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
  const here = () => new Request(req.url, { method: req.method, headers: arrivalHeaders(req.headers, arrivedAt), body })

  // Only tool calls need the database. The handshake, the tool list, notifications and non-MCP requests (OAuth
  // metadata, a 401) are answered here, saving a hop each (forward.ts, needsDbRegion).
  if (!needsDbRegion(body)) return handleHere(here())

  try {
    const res = await fetch(forwardUrl(MCP_URL, req.url), {
      method: req.method,
      headers: forwardHeaders(req.headers, DB_REGION!, HERE_REGION ?? undefined, Date.now()),
      body,
      redirect: 'manual',
    })
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders(res.headers, res.headers.get('x-sb-edge-region')),
    })
  } catch (e) {
    // Slow (every query crosses regions) but working beats failing
    console.error('forward to', DB_REGION, 'failed, handling here:', (e as Error).message)
    return handleHere(here())
  }
})

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)

  // RFC 9728 protected resource metadata. Clients find it through the WWW-Authenticate header, so it can live under
  // this function's path (we don't control the domain root).
  if (url.pathname.endsWith('/.well-known/oauth-protected-resource')) {
    return Response.json({
      resource: MCP_URL,
      authorization_servers: [AUTH_ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: SCOPES,
      resource_name: 'kr-stock-movers',
    })
  }

  // The operator's key (scripts, benchmarks): no login
  if (url.searchParams.get('key') === MCP_ACCESS_KEY) return handler.fetch(req)

  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) return unauthorized('login required')
  const token = header.slice(7).trim()
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: AUTH_ISSUER })
    if (!payload.sub || payload.role !== 'authenticated') return unauthorized('not a user token')
    if (!isAllowed(ALLOWED_USERS, payload.sub, payload.email)) {
      console.warn(`login refused: ${payload.sub} is not on ALLOWED_USERS`)
      return forbidden()
    }
    return handler.fetch(req, {
      authInfo: {
        token,
        clientId: String(payload.client_id ?? ''),
        scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
        expiresAt: payload.exp,
        extra: { userId: payload.sub },
      },
    })
  } catch (e) {
    return unauthorized(`invalid token: ${(e as Error).message}`)
  }
}
