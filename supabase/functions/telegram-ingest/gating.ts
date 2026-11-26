// telegram-ingest's gate step (../_shared/gate.ts): after polling, the newest posts not gated yet (gated_at null) go
// through the gate, a batch per run, and their label, checked tags and events are written back. That covers new posts,
// edited ones (a trigger resets gated_at), re-gating after an event is added, and the backfill of older posts, which
// drains at GATE_BATCH posts per 5-minute run. A failed call leaves the post ungated (shown, untagged) for the next
// run. An event is offered only to posts inside its window (eventsAt). Two runs at once (a manual ?gate=N during a
// scheduled run) can take the same posts: harmless, a post is just gated twice. Also keeps us_symbols fresh (daily) for the US check and find_us_stock.
// A Telegram post over CHUNK_POSTS_OVER characters is gated as numbered chunks (../_shared/chunk.ts), and its chunks
// are stored with their own tags in telegram_chunks (replaced on every gating; none for a shorter post).

import type Anthropic from 'npm:@anthropic-ai/sdk@1.5.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0'
import {
  askGate, checker, chunkTags, GATE_VERSION, type GateEvent, type GateInput, parseSymbolFile, type Stock, SYMBOL_FILES,
  symbolFileUrl, type UsSymbol,
} from '../_shared/gate.ts'
import { CHUNK_POSTS_OVER, chunkPost } from '../_shared/chunk.ts'

export const GATE_BATCH = 40 // posts per run: ~10 s at 8 calls at a time; a backlog of 1,000 posts drains in ~2 hours
export const GATE_MAX = 500 // posts in one gate-only run (?gate=N), within the deadline below
const GATE_DEADLINE_MS = 100_000 // no new calls after this, so a run ends well inside the 150 s Edge Function limit
const GATE_CONCURRENCY = 8
const LISTS_TTL_MS = 6 * 3600_000 // the stock and symbol lists change daily at most
const SYMBOLS_MAX_AGE_MS = 20 * 3600_000
const MIN_SYMBOLS = 5000 // ~7,500 listed; far fewer means the files changed format or came back cut

export type GateSummary = {
  gated: number
  noise: number
  failed: number
  left: number | null // still ungated after this run (the backlog)
  tokens: { input: number; output: number }
  ms: number
  errors?: string[] // the first few failures
  error?: string // every call failed: something systematic (key, outage), so the run fails and alerts
}

async function allRows<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

// The KRX stock list (latest day) and the US symbol list, cached per function instance
let lists: { stocks: Stock[]; symbols: UsSymbol[]; at: number } | null = null
async function loadLists(supabase: SupabaseClient) {
  if (lists && Date.now() - lists.at < LISTS_TTL_MS) return lists
  const { data: last, error } = await supabase.from('available_dates').select('bas_dd').order('bas_dd', { ascending: false }).limit(1)
  if (error) throw new Error(error.message)
  const day = last?.[0]?.bas_dd
  const stocks = await allRows<Stock>((a, b) =>
    supabase.from('prices').select('isu_cd, isu_nm').eq('bas_dd', day).order('isu_cd').range(a, b)
  )
  const symbols = await allRows<UsSymbol>((a, b) => supabase.from('us_symbols').select('ticker, name').order('ticker').range(a, b))
  lists = { stocks, symbols, at: Date.now() }
  return lists
}

/** Refreshes us_symbols from Nasdaq Trader's files when the stored list is older than a day (or empty). */
export async function refreshUsSymbols(supabase: SupabaseClient, fetcher: typeof fetch = fetch) {
  const { data: latest, error } = await supabase.from('us_symbols').select('updated_at').order('updated_at', { ascending: false }).limit(1)
  if (error) throw new Error(error.message)
  const at = latest?.[0]?.updated_at
  if (at && Date.now() - Date.parse(at) < SYMBOLS_MAX_AGE_MS) return { refreshed: false }
  const symbols: Required<UsSymbol>[] = []
  for (const file of SYMBOL_FILES) {
    const res = await fetcher(symbolFileUrl(file))
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
    symbols.push(...parseSymbolFile(file, await res.text()))
  }
  if (symbols.length < MIN_SYMBOLS) throw new Error(`only ${symbols.length} US symbols parsed (expected ${MIN_SYMBOLS}+): kept the stored list`)
  const now = new Date().toISOString()
  const unique = [...new Map(symbols.map((s) => [s.ticker, { ...s, updated_at: now }])).values()]
  for (let i = 0; i < unique.length; i += 1000) {
    const { error: e } = await supabase.from('us_symbols').upsert(unique.slice(i, i + 1000), { onConflict: 'ticker' })
    if (e) throw new Error(`us_symbols: ${e.message}`)
  }
  // Delisted: not in today's files
  const { error: d } = await supabase.from('us_symbols').delete().lt('updated_at', now)
  if (d) throw new Error(`us_symbols cleanup: ${d.message}`)
  lists = null // the next gate run reloads the lists
  return { refreshed: true, symbols: unique.length }
}

// Runs fn over items, n at a time; after `until` (performance.now()) no new item starts. Returns how many started.
type WindowedEvent = GateEvent & { active_from: string; active_to: string | null }

/**
 * The events a post can be tagged with: those whose window holds the post's time (active_from ≤ ts < active_to; no
 * end while active_to is null). So a post from before an event's start is never offered it, whenever it's gated.
 */
export function eventsAt(events: WindowedEvent[], ts: string): GateEvent[] {
  const t = Date.parse(ts)
  return events
    .filter((e) => Date.parse(e.active_from) <= t && (!e.active_to || t < Date.parse(e.active_to)))
    .map(({ id, description }) => ({ id, description }))
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, until = Infinity) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length && performance.now() < until) await fn(items[next++])
  }))
  return next
}

// Which posts a gate batch works on: Telegram's (telegram-ingest) or X's (x-ingest). Same columns for the results.
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>
export type GateTarget = {
  table: string
  columns: string
  input: (row: Row) => GateInput // what the model reads
  key: (row: Row) => Record<string, string | number> // the row to write back to
  name: (row: Row) => string // in error messages
  chunks?: string // the table long posts' chunks go to (Telegram only)
}
export const TELEGRAM_POSTS: GateTarget = {
  table: 'telegram_messages',
  columns: 'username, msg_id, ts, text, has_media, forwarded_from',
  input: (r) => ({ username: r.username, ts: r.ts, text: r.text, has_media: r.has_media, forwarded_from: r.forwarded_from }),
  key: (r) => ({ username: r.username, msg_id: r.msg_id }),
  name: (r) => `${r.username}/${r.msg_id}`,
  chunks: 'telegram_chunks',
}
// An X post is read with the post it quotes (a quote is often only a comment on it), and its images count as media
export const X_POSTS: GateTarget = {
  table: 'x_posts',
  columns: 'id, username, ts, text, quoted_text, media',
  input: (r) => ({
    username: `@${r.username} (X)`,
    ts: r.ts,
    text: r.quoted_text ? `${r.text}\n\n[quoting another post]\n${r.quoted_text}` : r.text,
    has_media: (r.media ?? []).length > 0,
    forwarded_from: null,
  }),
  key: (r) => ({ id: r.id }),
  name: (r) => `@${r.username}/${r.id}`,
}

/** Gates up to `limit` of the newest ungated posts (Telegram's unless another target is given) and writes the results back. */
/** `stopAt` (epoch ms, optional): the caller's own deadline; no call starts after it or after GATE_DEADLINE_MS. */
export async function gateBatch(
  supabase: SupabaseClient, client: Anthropic, limit = GATE_BATCH, target = TELEGRAM_POSTS, stopAt = Infinity,
): Promise<GateSummary> {
  const t0 = performance.now()
  const until = Math.min(t0 + GATE_DEADLINE_MS, t0 + (stopAt - Date.now()))
  const sum: GateSummary = { gated: 0, noise: 0, failed: 0, left: null, tokens: { input: 0, output: 0 }, ms: 0 }
  const { data: posts, error } = await supabase.from(target.table)
    .select(target.columns)
    .is('gated_at', null).order('ts', { ascending: false }).limit(limit)
  if (error) throw new Error(error.message)
  if (posts?.length) {
    const [{ stocks, symbols }, ev] = await Promise.all([
      loadLists(supabase),
      supabase.from('telegram_events').select('id, description, active_from, active_to').order('id'),
    ])
    if (ev.error) throw new Error(ev.error.message)
    const allEvents = (ev.data ?? []) as WindowedEvent[]
    const check = checker(stocks, symbols)
    const errors: string[] = []
    await pool(posts as unknown as Row[], GATE_CONCURRENCY, async (p) => {
      try {
        const input = target.input(p)
        const parts = target.chunks && input.text.length > CHUNK_POSTS_OVER ? chunkPost(input.text) : []
        const chunks = parts.length > 1 ? parts : []
        const a = await askGate(client, chunks.length ? { ...input, chunks } : input, eventsAt(allEvents, p.ts))
        const c = check(a.companies)
        // Chunks first: if saving the post fails after this, it stays ungated and the next run replaces them
        if (target.chunks) {
          const del = await supabase.from(target.chunks).delete().match(target.key(p))
          if (del.error) throw new Error(`chunks: ${del.error.message}`)
          if (chunks.length) {
            const tags = chunkTags(chunks, a.companies, check, a.chunkEvents)
            const ins = await supabase.from(target.chunks)
              .insert(chunks.map((text, idx) => ({ ...target.key(p), idx, text, ...tags[idx] })))
            if (ins.error) throw new Error(`chunks: ${ins.error.message}`)
          }
        }
        const { error: e } = await supabase.from(target.table).update({
          label: a.label,
          stock_codes: c.kr,
          us_tickers: c.us,
          events: a.events,
          gate_version: GATE_VERSION,
          gated_at: new Date().toISOString(),
        }).match(target.key(p))
        if (e) throw new Error(`save: ${e.message}`)
        sum.gated++
        if (a.label === 'noise') sum.noise++
        sum.tokens.input += a.usage?.input ?? 0
        sum.tokens.output += a.usage?.output ?? 0
      } catch (e) {
        sum.failed++
        if (errors.length < 3) errors.push(`${target.name(p)}: ${(e as Error).message.slice(0, 200)}`)
      }
    }, until)
    if (errors.length) sum.errors = errors
    // Every call failed: not one odd post but the key, the API or the schema. Fails the run, which alerts (hourly).
    if (sum.failed && !sum.gated && sum.failed >= Math.min(3, posts.length)) sum.error = `gate: every call failed: ${errors[0]}`
  }
  const { count } = await supabase.from(target.table).select('ts', { count: 'exact', head: true }).is('gated_at', null)
  sum.left = count ?? null
  sum.ms = Math.round(performance.now() - t0)
  return sum
}
