// MCP server for the daily KR-stock movers report.
// Reads from Postgres (filled by kis-ingest / krx-ingest). The only outside call is a live KIS quote for one
// stock in analyze_stock during the session.
//
// URL to give ChatGPT / Claude (users log in with OAuth; see "Auth" at the bottom):
//   https://<project-ref>.supabase.co/functions/v1/mcp
// Legacy shared URL, kept during the transition:
//   https://<project-ref>.supabase.co/functions/v1/mcp?key=<MCP_ACCESS_KEY>

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@^2.0.0'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@^4.3.6'
import { createRemoteJWKSet, jwtVerify } from 'npm:jose@^5.9.6'
import { kisGet, kisToken, num, sessionElapsed } from '../_shared/kis.ts'
import { registerTelegramTools } from './telegram.ts'
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

// Same-day rows come from KIS snapshots (every 5 minutes during the session) and are provisional until KRX's
// official data replaces them the next morning
async function dataStatus(day: string) {
  const { data, error } = await supabase.from('available_dates').select('final, as_of').eq('bas_dd', day)
  if (error) throw new Error(error.message)
  const d = data?.[0]
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

// Live quote for one stock (KIS 주식현재가 시세), used by analyze_stock while the market is open
async function liveQuote(code: string) {
  const token = await kisToken(supabase)
  const { output: o } = await kisGet(token, '/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: code,
  })
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

async function latestDate(): Promise<string | null> {
  const { data, error } = await supabase
    .from('prices')
    .select('bas_dd')
    .order('bas_dd', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return data?.[0]?.bas_dd ?? null
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}

// Usage logging: every tool call becomes one row in public.tool_calls. The insert runs after the response
// (EdgeRuntime.waitUntil), so logging never slows a tool down, and a failed insert never breaks one.
type Caller = { userId: string | null; auth: 'oauth' | 'shared_key'; client: string | null }

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

function logCall(caller: Caller, tool: string, args: unknown, started: number, result: unknown, err?: unknown) {
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
  }
  const p = supabase.from('tool_calls').insert(row).then(({ error }) => {
    if (error) console.error('tool_calls insert failed:', error.message)
  })
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(Promise.resolve(p))
}

// Wraps server.registerTool so every handler registered on this server is logged.
function withLogging(server: McpServer, caller: Caller): McpServer {
  // deno-lint-ignore no-explicit-any
  const register = server.registerTool.bind(server) as (...a: any[]) => any
  // deno-lint-ignore no-explicit-any
  ;(server as any).registerTool = (name: string, config: any, cb: (...a: any[]) => Promise<unknown>) =>
    // deno-lint-ignore no-explicit-any
    register(name, config, async (...a: any[]) => {
      // Tools without an inputSchema are called with (ctx) only; the rest with (args, ctx).
      const args = config?.inputSchema ? a[0] : null
      const started = performance.now()
      try {
        const result = await cb(...a)
        logCall(caller, name, args, started, result)
        return result
      } catch (e) {
        logCall(caller, name, args, started, undefined, e)
        throw e
      }
    })
  return server
}

const handler = createMcpHandler((ctx) => {
  const caller: Caller = {
    userId: (ctx.authInfo?.extra?.userId as string | undefined) ?? null,
    auth: ctx.authInfo?.extra?.userId ? 'oauth' : 'shared_key',
    client: ctx.requestInfo?.headers.get('user-agent') ?? null,
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
      const day = date ? normDate(date) : await latestDate()
      if (!day) return json({ error: 'No data ingested yet.' })

      const { data, error } = await supabase
        .from('prices')
        .select('*')
        .eq('bas_dd', day)
        .gte('fluc_rt', SHEET2_MIN_RATE)
        .order('fluc_rt', { ascending: false })
      if (error) throw new Error(error.message)

      const rows = (data ?? []) as Row[]
      if (rows.length === 0) {
        const { count } = await supabase
          .from('prices')
          .select('*', { count: 'exact', head: true })
          .eq('bas_dd', day)
        if (!count) {
          return json({
            date: day,
            error:
              'No data for this date. It may be a holiday/weekend, or the day has not closed yet ' +
              '(data appears from ~09:05 KST). Call check_available_dates.',
          })
        }
      }

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
        ...(await dataStatus(day)),
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
        days: z.number().int().min(1).max(250).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ code, days }) => {
      const { data, error } = await supabase
        .from('prices')
        .select('*')
        .eq('isu_cd', code)
        .order('bas_dd', { ascending: false })
        .limit(days)
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as Row[]
      return json({
        종목코드: code,
        종목명: rows[0]?.isu_nm ?? null,
        rows: rows.map((r) => ({ 일자: r.bas_dd, ...present(r) })),
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
      const day = a.date ? normDate(a.date) : await latestDate()
      if (!day) return json({ error: 'No data ingested yet.' })

      const { data, error } = await supabase.rpc('screen_stocks', {
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
      })
      if (error) throw new Error(error.message)

      const rows = (data ?? []) as Record<string, any>[]
      const { date: _d, limit: _l, ...filters } = a
      // The 60/120-day highs are skipped in SQL unless asked for; leave the keys out rather than return nulls
      // that read as missing history
      const with60 = a.breakout_days?.some((n) => n >= 60) ?? false
      const with120 = a.breakout_days?.includes(120) ?? false
      return json({
        date: day,
        ...(await dataStatus(day)),
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
        const { data, error } = await supabase
          .from('prices')
          .select('isu_cd, isu_nm, market')
          .eq('bas_dd', await latestDate())
          .ilike('isu_nm', `%${code}%`)
          .limit(20)
        if (error) throw new Error(error.message)
        const exact = (data ?? []).find((r) => r.isu_nm === code)
        if (exact) code = exact.isu_cd
        else if (data?.length === 1) code = data[0].isu_cd
        else return json({ error: data?.length ? 'Ambiguous name; pass a 종목코드.' : 'No stock found.', candidates: data })
      }
      code = code.toUpperCase()

      let q = supabase.from('prices').select('*').eq('isu_cd', code)
      if (date) q = q.lte('bas_dd', normDate(date))
      const { data, error } = await q.order('bas_dd', { ascending: false }).limit(250)
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as Row[]
      if (rows.length === 0) return json({ error: `No data for ${code}${date ? ` on or before ${normDate(date)}` : ''}.` })
      const result: Record<string, unknown> = { ...analyze(rows, opts), ...(await dataStatus(rows[0].bas_dd)) }
      const elapsed = sessionElapsed(new Date())
      if (rows[0].bas_dd === todayKstIso() && elapsed > 0 && elapsed < 1) {
        try {
          result.live_quote = await liveQuote(code)
        } catch (e) {
          result.live_quote_error = (e as Error).message
        }
      }
      return json(date && result.date !== normDate(date) ? { note: `No row on ${normDate(date)}; using ${result.date}.`, ...result } : result)
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
      const { data, error } = await supabase
        .from('prices')
        .select('isu_cd, isu_nm, market')
        .eq('bas_dd', day)
        .ilike('isu_nm', `%${name}%`)
        .limit(20)
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
      const dates = () => supabase.from('available_dates').select('bas_dd, row_count')

      if (date) {
        const day = normDate(date)
        const [hit, prev, next] = await Promise.all([
          dates().eq('bas_dd', day),
          dates().lt('bas_dd', day).order('bas_dd', { ascending: false }).limit(1),
          dates().gt('bas_dd', day).order('bas_dd', { ascending: true }).limit(1),
        ])
        for (const r of [hit, prev, next]) if (r.error) throw new Error(r.error.message)
        if (hit.data?.length) {
          return json({ date: day, available: true, stocks: hit.data[0].row_count, ...(await dataStatus(day)) })
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
        supabase.from('available_dates').select('*', { count: 'exact', head: true }),
        dates().order('bas_dd', { ascending: true }).limit(1),
        dates().order('bas_dd', { ascending: false }).limit(1),
      ])
      for (const r of [all, first, last]) if (r.error) throw new Error(r.error.message)
      const lastDay = last.data?.[0]?.bas_dd ?? null
      return json({
        total_days: all.count ?? 0,
        first: first.data?.[0]?.bas_dd ?? null,
        last: lastDay,
        ...(lastDay ? await dataStatus(lastDay) : {}),
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
// The old shared ?key= URL keeps working during the transition and is logged as auth = 'shared_key'.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const AUTH_ISSUER = `${SUPABASE_URL}/auth/v1`
const MCP_URL = `${SUPABASE_URL}/functions/v1/mcp`
const RESOURCE_METADATA_URL = `${MCP_URL}/.well-known/oauth-protected-resource`
const jwks = createRemoteJWKSet(new URL(`${AUTH_ISSUER}/.well-known/jwks.json`))
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

Deno.serve(async (req) => {
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

  // Transition: the shared ?key= URL still works.
  if (url.searchParams.get('key') === MCP_ACCESS_KEY) return handler.fetch(req)

  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) return unauthorized('login required')
  const token = header.slice(7).trim()
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: AUTH_ISSUER })
    if (!payload.sub || payload.role !== 'authenticated') return unauthorized('not a user token')
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
})
