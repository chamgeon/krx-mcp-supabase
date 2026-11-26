// Market indicators into public.market_quotes (one row per symbol, overwritten each run: the current value and the
// previous close; no history), and tracked US stocks / ETFs into public.us_quotes (same, one row per ticker).
//
//   POST /functions/v1/market-ingest?set=live    -> KIS: KRW/USD; plus KOSPI / KOSDAQ during 09:00–15:40 KST
//   POST /functions/v1/market-ingest?set=bonds   -> KIS: 국고채 1/3/5/10/20/30년 yields
//   POST /functions/v1/market-ingest?set=us      -> Yahoo Finance (yahoo-finance2): US indices and Treasury yields
//                                                   (market_quotes), and the US tickers mentioned in Telegram / X
//                                                   posts in the last 90 days plus fixed ETFs (us_quotes); ./us.ts
//
// Called by pg_cron (sql/cron.example.sql): `live` every 5 min 09:00–02:00 KST on weekdays (the Seoul FX session),
// `bonds` once a day at 18:30 KST, `us` every 5 min 22:00–06:55 KST on US weekdays. Protected by the x-ingest-secret
// header. Each set is recorded as its own job (market-ingest-live / -bonds / -us). KIS symbols are fetched one by one,
// so one failing symbol doesn't stop the others; the run then fails (500) and names it, and the alert goes out as for
// other jobs. Yahoo is one call per 1,000 symbols: a failed call fails the run; a stock missing from the answer is
// only listed (`missing`), an index or yield missing fails it.

import 'jsr:@supabase/functions-js@2.119.0/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { kisGet, kisToken } from '../_shared/kis.ts'
import { monitored } from '../_shared/ops.ts'
import { BONDS, chartDate, FX, inIndexHours, INDICES, type Kind, parseChart, parseIndex, type Quote } from './parse.ts'
import YahooFinance from 'jsr:@gadicc/yahoo-finance2@4.0.5'
import { marketQuoteOf, MENTION_DAYS, QUOTE_BATCH, toYahoo, trackedTickers, US_INDICES, US_YIELDS, usQuoteOf, type UsQuote } from './us.ts'

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

// Each set is its own job in ingest_runs (market-ingest-live / -bonds / -us): its own hourly alert throttle and its
// own line in the daily report. An unknown set is recorded as market-ingest-<set> and fails (400).
const jobOf = (req: Request) => `market-ingest-${new URL(req.url).searchParams.get('set') ?? 'live'}`.slice(0, 40)

Deno.serve(monitored(jobOf, supabase, async (req) => {
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }
  const set = new URL(req.url).searchParams.get('set') ?? 'live'
  if (set === 'us') {
    try {
      const body = await usSet()
      return Response.json(body, { status: body.error ? 500 : 200 })
    } catch (e) {
      return Response.json({ set, error: (e as Error).message }, { status: 500 })
    }
  }
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

// ---- ?set=us (Yahoo Finance) -------------------------------------------------------------------------------------

/** Every row of a query, 1,000 at a time (PostgREST's page size). */
async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if ((data ?? []).length < 1000) return out
  }
}

/** US tickers in Telegram / X posts of the last MENTION_DAYS days, kept only if listed in us_symbols. */
async function mentionedTickers(): Promise<{ mentioned: Set<string>; listed: Set<string> }> {
  const since = new Date(Date.now() - MENTION_DAYS * 86400_000).toISOString()
  const tagged = async (table: 'telegram_messages' | 'x_posts') =>
    allRows<{ us_tickers: string[] }>((a, b) =>
      supabase.from(table).select('us_tickers').gte('ts', since).neq('us_tickers', '{}').order('ts').range(a, b))
  const [tg, x] = await Promise.all([tagged('telegram_messages'), tagged('x_posts')])
  const mentioned = new Set([...tg, ...x].flatMap((r) => r.us_tickers ?? []))
  const listed = new Set<string>()
  const list = [...mentioned]
  for (let i = 0; i < list.length; i += 200) {
    const { data, error } = await supabase.from('us_symbols').select('ticker').in('ticker', list.slice(i, i + 200))
    if (error) throw new Error(`us_symbols: ${error.message}`)
    for (const r of data ?? []) listed.add(r.ticker)
  }
  return { mentioned, listed }
}

async function usSet() {
  const { mentioned, listed } = await mentionedTickers()
  const tracked = trackedTickers(mentioned, listed)
  const marketSpecs = [...US_INDICES.map((s) => ({ s, kind: 'index' as const })), ...US_YIELDS.map((s) => ({ s, kind: 'rate' as const }))]
  const symbols = [...marketSpecs.map((m) => m.s.yahoo), ...tracked.map((t) => toYahoo(t.ticker))]

  const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
  // deno-lint-ignore no-explicit-any
  const bySymbol = new Map<string, any>()
  for (let i = 0; i < symbols.length; i += QUOTE_BATCH) {
    // deno-lint-ignore no-explicit-any
    const got = await yf.quote(symbols.slice(i, i + QUOTE_BATCH), {}, { validateResult: false }) as any[]
    for (const q of got ?? []) bySymbol.set(q.symbol, q)
  }

  const errors: string[] = []
  const quotes: Quote[] = []
  for (const { s, kind } of marketSpecs) {
    const q = marketQuoteOf(bySymbol.get(s.yahoo), s, kind)
    if (q) quotes.push(q)
    else errors.push(`${s.symbol} (${s.yahoo}): no value in Yahoo's answer`)
  }
  const stocks: UsQuote[] = []
  const missing: string[] = []
  for (const t of tracked) {
    const q = usQuoteOf(bySymbol.get(toYahoo(t.ticker)), t.ticker, t.because)
    if (q) stocks.push(q)
    else missing.push(t.ticker)
  }

  const fetched_at = new Date().toISOString()
  if (quotes.length) {
    const { error } = await supabase.from('market_quotes').upsert(quotes.map((q) => ({ ...q, fetched_at })), { onConflict: 'symbol' })
    if (error) throw new Error(`market_quotes: ${error.message}`)
  }
  for (let i = 0; i < stocks.length; i += 500) {
    const { error } = await supabase.from('us_quotes').upsert(stocks.slice(i, i + 500).map((q) => ({ ...q, fetched_at })), { onConflict: 'ticker' })
    if (error) throw new Error(`us_quotes: ${error.message}`)
  }
  // Tickers no longer tracked (not mentioned for MENTION_DAYS days) leave the table
  let removed = 0
  if (stocks.length) {
    const keep = tracked.map((t) => `"${t.ticker.replace(/"/g, '')}"`).join(',')
    const { data, error } = await supabase.from('us_quotes').delete().not('ticker', 'in', `(${keep})`).select('ticker')
    if (error) throw new Error(`us_quotes cleanup: ${error.message}`)
    removed = data?.length ?? 0
  }

  return {
    set: 'us',
    market: quotes.map((q) => `${q.symbol} ${q.price} (${q.value_date})`),
    tracked: { mentioned: tracked.filter((t) => t.because === 'mentioned').length, etf: tracked.filter((t) => t.because === 'etf').length, not_listed: mentioned.size - listed.size },
    stored: stocks.length,
    ...(missing.length ? { missing } : {}),
    ...(removed ? { removed } : {}),
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}
