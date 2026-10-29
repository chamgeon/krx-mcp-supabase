// Same-day snapshot of every KOSPI + KOSDAQ stock from the KIS (한국투자증권) Open API, stored in
// public.daily_prices with source = 'kis'. krx-ingest overwrites the day with KRX's official numbers
// the next morning.
//
// Called by pg_cron (see sql/cron.sql). Protected by the x-ingest-secret header.
//
//   POST /functions/v1/kis-ingest   -> snapshot today (no-op on weekends and holidays)
//
// KIS has no whole-market endpoint, so the stock list comes from the latest stored day, and the
// fields KIS doesn't return (market, 소속부, 상장주식수) are carried forward from it.
// 시가총액 = 종가 × carried-forward 상장주식수, which is how KRX computes it.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'

const KIS_BASE = 'https://openapi.koreainvestment.com:9443'
const MULTI_MAX = 30 // intstock-multprice: up to 30 stocks per call

const KIS_APP_KEY = Deno.env.get('KIS_APP_KEY')!
const KIS_APP_SECRET = Deno.env.get('KIS_APP_SECRET')!
const INGEST_SECRET = Deno.env.get('INGEST_SECRET')!
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

type Prev = {
  isu_cd: string
  isu_nm: string
  market: string
  sect_tp_nm: string | null
  list_shrs: number | null
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/,/g, '').trim()
  if (s === '' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Today in Korea as YYYYMMDD
function todayKst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}
function toIsoDate(s: string): string {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Access tokens last 24h and KIS limits issuance (~1/min), so the token is cached in Postgres.
async function kisToken(): Promise<string> {
  const { data, error } = await supabase.from('kis_token').select('*').eq('id', 1).maybeSingle()
  if (error) throw new Error(`kis_token: ${error.message}`)
  if (data && new Date(data.expires_at).getTime() - Date.now() > 10 * 60_000) return data.access_token

  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET }),
  })
  if (!res.ok) throw new Error(`KIS token: HTTP ${res.status} ${await res.text()}`)
  const j = await res.json()
  const expires_at = new Date(Date.now() + Number(j.expires_in) * 1000).toISOString()
  const { error: upErr } = await supabase
    .from('kis_token')
    .upsert({ id: 1, access_token: j.access_token, expires_at })
  if (upErr) throw new Error(`kis_token: ${upErr.message}`)
  return j.access_token
}

async function kisGet(token: string, path: string, trId: string, params: Record<string, string>) {
  const url = `${KIS_BASE}${path}?${new URLSearchParams(params)}`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: KIS_APP_KEY,
        appsecret: KIS_APP_SECRET,
        tr_id: trId,
        custtype: 'P',
      },
    })
    const body = await res.json().catch(() => null)
    if (res.ok && body?.rt_cd === '0') return body
    // EGW00201 = 초당 거래건수 초과: back off and retry
    if (body?.msg_cd === 'EGW00201' && attempt < 5) {
      await sleep(1000)
      continue
    }
    throw new Error(`KIS ${trId}: HTTP ${res.status} ${body?.msg_cd ?? ''} ${body?.msg1 ?? ''}`.trim())
  }
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
      .from('daily_prices')
      .select('isu_cd, isu_nm, market, sect_tp_nm, list_shrs')
      .eq('bas_dd', dayIso)
      .order('isu_cd')
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as Prev[]))
    if (!data || data.length < 1000) return out
  }
}

async function snapshot(token: string, todayIso: string, prev: Prev[]): Promise<number> {
  const byCode = new Map(prev.map((p) => [p.isu_cd, p]))
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < prev.length; i += MULTI_MAX) {
    const params: Record<string, string> = {}
    prev.slice(i, i + MULTI_MAX).forEach((p, j) => {
      params[`FID_COND_MRKT_DIV_CODE_${j + 1}`] = 'J'
      params[`FID_INPUT_ISCD_${j + 1}`] = p.isu_cd
    })
    const body = await kisGet(token, '/uapi/domestic-stock/v1/quotations/intstock-multprice', 'FHKST11300006', params)
    for (const r of body.output ?? []) {
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
        source: 'kis',
      })
    }
    await sleep(100) // stay well under KIS's 20 calls/s
  }
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase
      .from('daily_prices')
      .upsert(rows.slice(i, i + 1000), { onConflict: 'bas_dd,isu_cd' })
    if (error) throw new Error(`upsert ${todayIso}: ${error.message}`)
  }
  return rows.length
}

Deno.serve(async (req) => {
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }

  const today = todayKst()
  const todayIso = toIsoDate(today)
  try {
    const token = await kisToken()
    const latest = await latestTradingDay(token)
    if (latest !== today) {
      return Response.json({ date: today, skipped: `not a trading day (latest is ${latest})` })
    }

    const { data: cur } = await supabase.from('available_dates').select('final').eq('bas_dd', todayIso)
    if (cur?.[0]?.final) return Response.json({ date: today, skipped: 'KRX data already loaded' })

    const prev = await previousDay(todayIso)
    if (!prev) throw new Error('no earlier day to take the stock list from')
    const stocks = await stocksOf(prev)
    const count = await snapshot(token, todayIso, stocks)
    return Response.json({ date: today, stock_list_from: prev, rows: count })
  } catch (e) {
    return Response.json({ date: today, error: (e as Error).message }, { status: 500 })
  }
})
