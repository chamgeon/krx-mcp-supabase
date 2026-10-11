// Pulls KOSPI + KOSDAQ 일별매매정보 from the KRX Open API and stores it in public.daily_prices.
//
// Called by pg_cron (see sql/cron.sql). Protected by the x-ingest-secret header.
//
//   POST /functions/v1/krx-ingest                         -> today + any missing weekdays in the last 7 days
//   POST /functions/v1/krx-ingest?date=20261008           -> (re)load one day
//   POST /functions/v1/krx-ingest?from=20260901&to=20261010 -> backfill a range (weekdays only)

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const KRX_BASE = 'https://data-dbg.krx.co.kr/svc/apis/sto'
const MARKETS = [
  { market: 'KOSPI', path: 'stk_bydd_trd' }, // 유가증권 일별매매정보
  { market: 'KOSDAQ', path: 'ksq_bydd_trd' }, // 코스닥 일별매매정보
] as const

const KRX_API_KEY = Deno.env.get('KRX_API_KEY')!
const INGEST_SECRET = Deno.env.get('INGEST_SECRET')!
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

// KRX returns every number as a string, often comma-formatted, and "-" for empty.
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/,/g, '').trim()
  if (s === '' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}
function parseYmd(s: string): Date {
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)))
}
function toIsoDate(s: string): string {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
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

async function fetchMarket(path: string, basDd: string): Promise<Record<string, string>[]> {
  const res = await fetch(`${KRX_BASE}/${path}?basDd=${basDd}`, {
    headers: { AUTH_KEY: KRX_API_KEY },
  })
  if (res.status === 429) throw new Error('KRX daily call limit reached (429)')
  if (!res.ok) throw new Error(`KRX ${path} ${basDd}: HTTP ${res.status} ${await res.text()}`)
  const json = await res.json()
  return Array.isArray(json?.OutBlock_1) ? json.OutBlock_1 : []
}

async function ingestDay(basDd: string): Promise<number> {
  const rows: Record<string, unknown>[] = []
  for (const { market, path } of MARKETS) {
    const items = await fetchMarket(path, basDd)
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
      })
    }
  }
  // Empty = holiday, or KRX hasn't published that day yet
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase
      .from('daily_prices')
      .upsert(rows.slice(i, i + 1000), { onConflict: 'bas_dd,isu_cd' })
    if (error) throw new Error(`upsert ${basDd}: ${error.message}`)
  }
  return rows.length
}

async function existingDates(fromIso: string, toIso: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('available_dates')
    .select('bas_dd')
    .gte('bas_dd', fromIso)
    .lte('bas_dd', toIso)
  if (error) throw new Error(error.message)
  return new Set((data ?? []).map((d) => String(d.bas_dd).replace(/-/g, '')))
}

Deno.serve(async (req) => {
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
    // Default: any weekday in the last 7 days we don't have yet, plus today (always re-fetched,
    // so the evening run overwrites the 16:10 run with final numbers incl. after-hours trading)
    const today = todayKst()
    const start = new Date(today.getTime() - 7 * 86400000)
    const have = await existingDates(toIsoDate(ymd(start)), toIsoDate(ymd(today)))
    for (let d = start; d < today; d = new Date(d.getTime() + 86400000)) {
      if (!isWeekend(d) && !have.has(ymd(d))) targets.push(ymd(d))
    }
    if (!isWeekend(today)) targets.push(ymd(today))
  }

  const results: Record<string, number | string> = {}
  for (const t of targets) {
    try {
      results[t] = await ingestDay(t)
    } catch (e) {
      results[t] = `error: ${(e as Error).message}`
      if (String(e).includes('429')) break
    }
  }
  return Response.json({ targets, results })
})
