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
