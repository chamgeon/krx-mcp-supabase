// MCP server for the daily KR-stock movers report.
// Reads only from Postgres (filled by krx-ingest); never calls KRX, so the KRX key stays here.
//
// URL to give ChatGPT / Claude:
//   https://<project-ref>.supabase.co/functions/v1/mcp?key=<MCP_ACCESS_KEY>

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createMcpHandler, McpServer } from 'npm:@modelcontextprotocol/server@^2.0.0'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@^4.3.6'

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

const EOK = 100_000_000 // 1억원

type Row = {
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
}

function charts(code: string) {
  // Naver Finance chart images (unofficial URLs; they always show the *current* chart, not as-of a past date)
  const img = 'https://ssl.pstatic.net/imgfinance/chart/item/candle'
  return {
    일봉: `${img}/day/${code}.png`,
    주봉: `${img}/week/${code}.png`,
    월봉: `${img}/month/${code}.png`,
    네이버_차트페이지: `https://finance.naver.com/item/fchart.naver?code=${code}`,
    네이버_종목페이지: `https://finance.naver.com/item/main.naver?code=${code}`,
  }
}

function present(r: Row) {
  return {
    종목코드: r.isu_cd,
    종목명: r.isu_nm,
    시장: r.market,
    소속부: r.sect_tp_nm,
    등락률: r.fluc_rt,
    종가: r.close,
    전일대비: r.change,
    시가: r.open,
    고가: r.high,
    저가: r.low,
    거래량: r.volume,
    거래대금_억원: r.trdval == null ? null : Math.round(r.trdval / EOK),
    시가총액_억원: r.mktcap == null ? null : Math.round(r.mktcap / EOK),
  }
}

async function latestDate(): Promise<string | null> {
  const { data, error } = await supabase
    .from('daily_prices')
    .select('bas_dd')
    .order('bas_dd', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return data?.[0]?.bas_dd ?? null
}

// Accepts "2026-10-08" or "20261008"
function normDate(d: string): string {
  const s = d.replace(/-/g, '')
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}

const eok = (v: number | null | undefined) => (v == null ? null : Math.round(v / EOK))
const round = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d
const pct = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || !b ? null : round((a / b - 1) * 100)

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null
}
function stddev(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = mean(xs)!
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

// --- analyze_stock -------------------------------------------------------------------------------
// `rows` are most-recent-first: rows[0] is the analysis date, rows[1] the trading day before, ...
// Definitions match screen_stocks (supabase/migrations/*_screen_stocks.sql).

type Signal = { code: string; detail: string }

function analyze(
  rows: Row[],
  opts: { avg_days: number; spike_ratio: number; sideways_days: number; sideways_max_range: number },
) {
  const close = rows.map((r) => r.close ?? 0)
  const trdval = rows.map((r) => r.trdval ?? 0)
  const volume = rows.map((r) => r.volume ?? 0)
  const n = rows.length
  const t = rows[0]
  const signals: Signal[] = []

  // Returns
  const ret = (k: number) => (n > k ? pct(close[0], close[k]) : null)
  const returns = { d1: ret(1), d5: ret(5), d10: ret(10), d20: ret(20), d60: ret(60), d120: ret(120) }

  // Trading value
  const avgPrior = (i: number, k: number) => (n >= i + 1 + k ? mean(trdval.slice(i + 1, i + 1 + k)) : null)
  const avgN = avgPrior(0, opts.avg_days)
  const avg5 = avgPrior(0, 5)
  const ratio = avgN ? round(trdval[0] / avgN) : null
  let trdvalUp = 0
  while (trdvalUp + 1 < n && trdval[trdvalUp] > trdval[trdvalUp + 1]) trdvalUp++
  const spikes = []
  for (let i = 0; i < Math.min(20, n); i++) {
    const a = avgPrior(i, opts.avg_days)
    if (a && trdval[i] / a >= opts.spike_ratio) {
      spikes.push({ date: rows[i].bas_dd, trdval_eok: eok(trdval[i]), ratio: round(trdval[i] / a), fluc_rt: rows[i].fluc_rt })
    }
  }
  const volAvgN = n >= 1 + opts.avg_days ? mean(volume.slice(1, 1 + opts.avg_days)) : null
  const volAvg5 = n >= 6 ? mean(volume.slice(1, 6)) : null
  const volRatio = volAvgN ? round(volume[0] / volAvgN) : null
  if (ratio != null && ratio >= opts.spike_ratio) {
    signals.push({ code: 'TRDVAL_SPIKE', detail: `거래대금이 직전 ${opts.avg_days}일 평균의 ${ratio}배` })
  }
  if (volRatio != null && volRatio >= opts.spike_ratio) {
    signals.push({ code: 'VOLUME_SPIKE', detail: `거래량이 직전 ${opts.avg_days}일 평균의 ${volRatio}배` })
  }
  if (trdvalUp >= 3) signals.push({ code: 'TRDVAL_RISING_STREAK', detail: `거래대금 ${trdvalUp}일 연속 증가` })

  // Moving averages (MA_k of closes ending at day i)
  const ma = (k: number, i = 0) => (n >= i + k ? mean(close.slice(i, i + k)) : null)
  const mas = Object.fromEntries(
    [5, 20, 60, 120].map((k) => {
      const v = ma(k)
      return [`ma${k}`, { value: round(v, 0), close_vs_ma_pct: pct(close[0], v), slope_5d_pct: pct(v, ma(k, 5)) }]
    }),
  )
  const [m5, m20, m60, m120] = [ma(5), ma(20), ma(60), ma(120)]
  const aligned = m5 != null && m20 != null && m60 != null && m120 != null
  const bullishAlignment = aligned && m5! > m20! && m20! > m60! && m60! > m120!
  const bearishAlignment = aligned && m5! < m20! && m20! < m60! && m60! < m120!
  if (bullishAlignment) signals.push({ code: 'MA_BULLISH_ALIGNMENT', detail: '정배열 (MA5 > MA20 > MA60 > MA120)' })
  if (bearishAlignment) signals.push({ code: 'MA_BEARISH_ALIGNMENT', detail: '역배열 (MA5 < MA20 < MA60 < MA120)' })
  const p5 = ma(5, 1), p20 = ma(20, 1)
  if (m5 != null && m20 != null && p5 != null && p20 != null) {
    if (p5 <= p20 && m5 > m20) signals.push({ code: 'GOLDEN_CROSS_5_20', detail: 'MA5가 오늘 MA20을 상향 돌파' })
    if (p5 >= p20 && m5 < m20) signals.push({ code: 'DEAD_CROSS_5_20', detail: 'MA5가 오늘 MA20을 하향 돌파' })
  }

  // Breakouts: close > highest high of the prior k days
  const breakouts = Object.fromEntries(
    [20, 60, 120].map((k) => {
      if (n <= k) return [`d${k}`, null]
      const prior = rows.slice(1, k + 1)
      const hi = Math.max(...prior.map((r) => r.high ?? 0))
      const lo = Math.min(...prior.map((r) => r.low ?? Infinity).filter((v) => v > 0))
      const broke = close[0] > hi
      if (broke) signals.push({ code: `BREAKOUT_${k}D`, detail: `종가가 직전 ${k}일 최고가(${hi}) 돌파` })
      return [`d${k}`, { prior_high: hi, prior_low: lo, breakout: broke, close_vs_high_pct: pct(close[0], hi) }]
    }),
  )

  // Volatility and streaks
  const fluc20 = rows.slice(0, 20).map((r) => Number(r.fluc_rt ?? 0))
  const vol20 = stddev(fluc20)
  const trs = []
  for (let i = 0; i < Math.min(14, n - 1); i++) {
    const r = rows[i], pc = close[i + 1]
    trs.push(Math.max((r.high ?? 0) - (r.low ?? 0), Math.abs((r.high ?? 0) - pc), Math.abs((r.low ?? 0) - pc)))
  }
  let up = 0, down = 0
  while (up + 1 < n && close[up] > close[up + 1]) up++
  while (down + 1 < n && close[down] < close[down + 1]) down++
  if (up >= 3) signals.push({ code: 'PRICE_UP_STREAK', detail: `${up}일 연속 상승` })
  if (down >= 3) signals.push({ code: 'PRICE_DOWN_STREAK', detail: `${down}일 연속 하락` })

  // Consolidation (box) and price / trading-value divergence
  let consolidation = null
  const sd = opts.sideways_days
  if (n >= sd) {
    const box = rows.slice(0, sd)
    const hi = Math.max(...box.map((r) => r.high ?? 0))
    const lo = Math.min(...box.map((r) => r.low ?? Infinity).filter((v) => v > 0))
    const range = pct(hi, lo)
    const recent = mean(trdval.slice(0, 5))
    const early = mean(trdval.slice(5, sd))
    const growth = recent != null && early ? round(recent / early) : null
    const priceChange = pct(close[0], close[sd - 1])
    const isBox = range != null && range <= opts.sideways_max_range
    consolidation = {
      days: sd,
      box_high: hi,
      box_low: lo,
      range_pct: range,
      is_consolidating: isBox,
      price_change_pct: priceChange,
      trdval_recent5_avg_eok: eok(recent),
      trdval_earlier_avg_eok: eok(early),
      trdval_growth: growth,
    }
    if (isBox && growth != null && growth >= 1.5) {
      signals.push({ code: 'BOX_WITH_RISING_TRDVAL', detail: `${sd}일 박스권(${range}%) 속 거래대금 ${growth}배 증가 — 매집 가능성` })
    } else if (isBox) {
      signals.push({ code: 'CONSOLIDATION', detail: `${sd}일 고저 범위 ${range}%` })
    }
    if (priceChange != null && growth != null) {
      if (priceChange >= 5 && growth <= 0.7) {
        signals.push({ code: 'RALLY_ON_FADING_TRDVAL', detail: `${sd}일 ${priceChange}% 상승했지만 최근 거래대금은 ${growth}배로 감소` })
      }
      if (priceChange <= -5 && growth >= 1.5) {
        signals.push({ code: 'DECLINE_ON_RISING_TRDVAL', detail: `${sd}일 ${priceChange}% 하락 중 거래대금 ${growth}배 증가 — 매도 압력` })
      }
    }
  }

  return {
    date: t.bas_dd,
    code: t.isu_cd,
    name: t.isu_nm,
    market: t.market,
    history_days: n,
    price: { close: t.close, open: t.open, high: t.high, low: t.low, fluc_rt: t.fluc_rt, mktcap_eok: eok(t.mktcap) },
    returns_pct: returns,
    trading_value: {
      today_eok: eok(trdval[0]),
      avg5_prior_eok: eok(avg5),
      [`avg${opts.avg_days}_prior_eok`]: eok(avgN),
      ratio_vs_avg: ratio,
      ratio_vs_avg5: avg5 ? round(trdval[0] / avg5) : null,
      consecutive_up_days: trdvalUp,
      spikes_last_20d: spikes,
    },
    volume: {
      today: volume[0],
      avg5_prior: round(volAvg5, 0),
      [`avg${opts.avg_days}_prior`]: round(volAvgN, 0),
      ratio_vs_avg: volRatio,
      ratio_vs_avg5: volAvg5 ? round(volume[0] / volAvg5) : null,
    },
    moving_averages: { ...mas, bullish_alignment: bullishAlignment, bearish_alignment: bearishAlignment },
    breakouts,
    volatility: {
      daily_stddev_20d_pct: round(vol20),
      annualized_pct: round(vol20 == null ? null : vol20 * Math.sqrt(250)),
      atr14_pct: trs.length && close[0] ? round((mean(trs)! / close[0]) * 100) : null,
    },
    streaks: { consecutive_up_days: up, consecutive_down_days: down },
    consolidation,
    signals,
  }
}

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'kr-stock-movers', version: '0.1.0' })

  server.registerTool(
    'get_daily_movers',
    {
      title: '국내 급등 종목 (Sheet 1 / Sheet 2 / Sheet 3)',
      description:
        'Returns the Korean stock (KOSPI+KOSDAQ) daily movers report for one trading day, already split into sheets: ' +
        `sheet1 = 등락률 >= +${SHEET1_MIN_RATE}%; ` +
        `sheet2 = 등락률 >= +${SHEET2_MIN_RATE}% AND 거래대금 >= 500억원, excluding sheet1 stocks; ` +
        'both sorted by 등락률 descending. sheet3 = 일봉/주봉/월봉 chart URLs for every stock in sheet1 and sheet2. ' +
        'Data is end-of-day from KRX: loaded at 15:40–16:10 KST and finalized at 18:40 KST (after-hours trading included). ' +
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
        .from('daily_prices')
        .select('*')
        .eq('bas_dd', day)
        .gte('fluc_rt', SHEET2_MIN_RATE)
        .order('fluc_rt', { ascending: false })
      if (error) throw new Error(error.message)

      const rows = (data ?? []) as Row[]
      if (rows.length === 0) {
        const { count } = await supabase
          .from('daily_prices')
          .select('*', { count: 'exact', head: true })
          .eq('bas_dd', day)
        if (!count) {
          return json({
            date: day,
            error:
              'No data for this date. It may be a holiday/weekend, or it is before ~15:40–16:10 KST and ' +
              "today's data isn't loaded yet. Call list_available_dates.",
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
        .from('daily_prices')
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
        'sideways_recent_days / avg of the rest of the box; breakout_N = close > highest high of the prior N days (null if history is short). ' +
        'Examples: 거래량 >= 3x prior 5-day average = {avg_days: 5, min_volume_ratio: 3}; ' +
        'box + rising 거래대금 = {max_sideways_range: 15, min_sideways_trdval_growth: 2}.',
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-?\d{2}-?\d{2}$/).optional().describe('YYYY-MM-DD or YYYYMMDD. Omit for the latest day.'),
        market: z.enum(['KOSPI', 'KOSDAQ']).optional(),
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
      return json({
        date: day,
        filters,
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
          breakout_60: r.breakout_60,
          breakout_120: r.breakout_120,
          high_20: r.high_20,
          high_60: r.high_60,
          high_120: r.high_120,
          history_days: r.history_days,
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
        'Metrics needing more history than is loaded are null.',
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
          .from('daily_prices')
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

      let q = supabase.from('daily_prices').select('*').eq('isu_cd', code)
      if (date) q = q.lte('bas_dd', normDate(date))
      const { data, error } = await q.order('bas_dd', { ascending: false }).limit(250)
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as Row[]
      if (rows.length === 0) return json({ error: `No data for ${code}${date ? ` on or before ${normDate(date)}` : ''}.` })
      const result = analyze(rows, opts)
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
        .from('daily_prices')
        .select('isu_cd, isu_nm, market')
        .eq('bas_dd', day)
        .ilike('isu_nm', `%${name}%`)
        .limit(20)
      if (error) throw new Error(error.message)
      return json(data ?? [])
    },
  )

  server.registerTool(
    'list_available_dates',
    {
      title: '저장된 거래일 목록',
      description: 'Trading days available in the database (most recent first).',
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(10) }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const { data, error } = await supabase
        .from('available_dates')
        .select('bas_dd, row_count')
        .order('bas_dd', { ascending: false })
        .limit(limit)
      if (error) throw new Error(error.message)
      return json(data ?? [])
    },
  )

  return server
})

Deno.serve((req) => {
  // Lightweight protection: secret key in the URL (?key=...). Edge Function MCP has no built-in auth.
  const key = new URL(req.url).searchParams.get('key')
  if (key !== MCP_ACCESS_KEY) return new Response('unauthorized', { status: 401 })
  return handler.fetch(req)
})
