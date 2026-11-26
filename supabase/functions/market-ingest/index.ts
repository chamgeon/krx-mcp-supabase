// Market indicators from the KIS (한국투자증권) Open API into public.market_quotes: one row per symbol, overwritten
// each run (the current value and the previous close; no history). Korean data only for now.
//
//   POST /functions/v1/market-ingest?set=live    -> KRW/USD; plus KOSPI / KOSDAQ during 09:00–15:40 KST
//   POST /functions/v1/market-ingest?set=bonds   -> 국고채 1/3/5/10/20/30년 yields
//
// Called by pg_cron (sql/cron.example.sql): `live` every 5 min 09:00–02:00 KST on weekdays (the Seoul FX session),
// `bonds` once a day at 18:30 KST. Protected by the x-ingest-secret header. Each symbol is fetched on its own, so one
// failing symbol doesn't stop the others; the run then fails (500) and names it, and the alert goes out as for other jobs.
//
// KOSPI / KOSDAQ come from inquire-index-price, which has no date; the trading day is the newest bar of KOSPI on the
// chart endpoint. On a holiday that's an earlier day, and the indices are skipped (their values haven't changed).

import 'jsr:@supabase/functions-js@2.119.0/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { kisGet, kisToken } from '../_shared/kis.ts'
import { monitored } from '../_shared/ops.ts'
import { BONDS, chartDate, FX, inIndexHours, INDICES, type Kind, parseChart, parseIndex, type Quote } from './parse.ts'

const INGEST_SECRET = Deno.env.get('INGEST_SECRET')!
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

const ymd = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '')
const todayIso = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)

const chart = (token: string, div: string, code: string) =>
  kisGet(token, '/uapi/overseas-price/v1/quotations/inquire-daily-chartprice', 'FHKST03030100', {
    FID_COND_MRKT_DIV_CODE: div,
    FID_INPUT_ISCD: code,
    FID_INPUT_DATE_1: ymd(Date.now() - 14 * 86400_000),
    FID_INPUT_DATE_2: ymd(Date.now()),
    FID_PERIOD_DIV_CODE: 'D',
  })
const index = (token: string, code: string) =>
  kisGet(token, '/uapi/domestic-stock/v1/quotations/inquire-index-price', 'FHPUP02100000', {
    FID_COND_MRKT_DIV_CODE: 'U',
    FID_INPUT_ISCD: code,
  })

Deno.serve(monitored('market-ingest', supabase, async (req) => {
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }
  const set = new URL(req.url).searchParams.get('set') ?? 'live'
  if (set !== 'live' && set !== 'bonds') return Response.json({ error: `unknown set: ${set}` }, { status: 400 })

  const quotes: Quote[] = []
  const errors: string[] = []
  const skipped: string[] = []
  const one = async (symbol: string, fetch: () => Promise<Quote | null>) => {
    try {
      const q = await fetch()
      if (q) quotes.push(q)
      else errors.push(`${symbol}: no value in KIS's answer`)
    } catch (e) {
      errors.push(`${symbol}: ${(e as Error).message}`)
    }
  }

  try {
    const token = await kisToken(supabase)
    const chartQuote = (kind: Kind, div: string, unit: Quote['unit']) => (s: typeof FX[number]) =>
      one(s.symbol, async () => parseChart(await chart(token, div, s.code), s, kind, unit))

    if (set === 'live') {
      for (const s of FX) await chartQuote('fx', 'X', 'KRW')(s)
      if (!inIndexHours(new Date())) {
        skipped.push('KOSPI/KOSDAQ: outside 09:00–15:40 KST')
      } else {
        const day = chartDate(await chart(token, 'N', 'KOSPI'))
        if (day !== todayIso()) skipped.push(`KOSPI/KOSDAQ: not a trading day (latest is ${day})`)
        else for (const s of INDICES) await one(s.symbol, async () => parseIndex(await index(token, s.code), s, day))
      }
    } else {
      for (const s of BONDS) await chartQuote('rate', 'I', '%')(s)
    }

    if (quotes.length) {
      const fetched_at = new Date().toISOString()
      const { error } = await supabase.from('market_quotes').upsert(quotes.map((q) => ({ ...q, fetched_at })), { onConflict: 'symbol' })
      if (error) throw new Error(`market_quotes: ${error.message}`)
    }
    const body = {
      set,
      stored: quotes.map((q) => `${q.symbol} ${q.price} (${q.value_date})`),
      ...(skipped.length ? { skipped } : {}),
      ...(errors.length ? { error: errors.join('; ') } : {}),
    }
    return Response.json(body, { status: errors.length ? 500 : 200 })
  } catch (e) {
    return Response.json({ set, error: (e as Error).message }, { status: 500 })
  }
}))
