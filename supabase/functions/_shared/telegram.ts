// Public Telegram channels, read from the web preview at https://t.me/s/<channel>.
//
// No Telegram account or API: the preview page is public HTML with the latest 20 posts, and ?before=<id> pages back
// through older ones. Only channels with the preview turned on can be read (private channels redirect to t.me/<name>).
// Polite by design: one request per channel per poll, a pause between pages, and a cap on backfill pages.
//
// Used by telegram-ingest (scheduled polling) and the MCP tools (add a channel, refresh before reading).

import { parseHTML } from 'npm:linkedom@0.18.5'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0'
import { readableError } from './errors.ts'

const UA = 'Mozilla/5.0 (compatible; kr-stock-mcp/1.0; public channel reader)'
const PAGE_PAUSE_MS = 800

// A new channel's history: ~30 days or 8 pages (20 posts each), whichever comes first (log 2026-11-16). The first page
// is fetched while the user waits; the rest in the background (backfillChannel).
export const BACKFILL_DAYS = 30
export const BACKFILL_MAX_PAGES = 8
// A pending backfill with no progress for this long was interrupted (its worker ended): telegram-ingest resumes it
export const BACKFILL_STALE_MS = 3 * 60_000

export type TgPost = {
  msg_id: number
  ts: string
  text: string
  views: number | null
  forwarded_from: string | null
  has_media: boolean
  links: string[]
  edited: boolean
}

export type TgPage = { title: string | null; posts: TgPost[] }

/** "@name", "name", "t.me/name", "https://t.me/s/name/123" → "name" (lowercase), or null if not a valid username. */
export function channelName(input: string): string | null {
  const s = input.trim().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/^(www\.)?t\.me\//, '').replace(/^s\//, '')
  const name = s.split(/[/?#]/)[0]
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? name.toLowerCase() : null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** "1.2K" → 1200, "4.09M" → 4090000 */
function parseViews(s: string | null | undefined): number | null {
  if (!s) return null
  const m = s.trim().match(/^([\d.]+)\s*([KM]?)$/i)
  if (!m) return null
  const n = parseFloat(m[1]) * (m[2].toUpperCase() === 'M' ? 1e6 : m[2].toUpperCase() === 'K' ? 1e3 : 1)
  return Math.round(n)
}

// ---- Where pages are fetched from ----
// Telegram hides some channels' previews from India: t.me/s/stockbot redirects from ap-south-1 (Mumbai) but loads from
// Seoul, Tokyo and Singapore (log 2026-11-20). telegram-ingest runs in Seoul (its cron sends x-region) and fetches
// directly. mcp runs next to the database in Mumbai, so it fetches through telegram-ingest's ?page relay in Seoul
// (relayPages, set by mcp when TG_REGION is set).

export type RawPage = { status: number; html: string }
export type PageSource = (channel: string, before?: number) => Promise<RawPage>

const previewUrl = (channel: string, before?: number) => `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`

// t.me sometimes resets a connection, or holds it open for a minute and a half first (2026-11-21: itechkorea at 03:20
// KST, a 117 s run against a p50 of ~18 s; ehdwl at 05:50), and the next run works. So each attempt has a timeout,
// and a network error (not an HTTP answer) is tried once more after a short pause. 10 s: a healthy channel takes
// ~1 s (p99 ~2.4 s, fetch and DB writes, 3 days of runs), so a stuck channel costs at most ~21 s. When Telegram is
// unreachable for every channel at once (15:35 the same day: 6 channels × 21 s, then the 150 s limit), that's
// telegram-ingest's poll loop to stop (../telegram-ingest/polling.ts), not this timeout's.
export const PAGE_TIMEOUT_MS = 10_000
export const PAGE_ATTEMPTS = 2
const RETRY_PAUSE_MS = 1_000

/** t.me gave no HTTP answer (connection error or timeout) on every attempt. */
export class PageNetworkError extends Error {
  override name = 'PageNetworkError'
}

/**
 * Fetches a preview page from here. A redirect (no preview) comes back as its 3xx status, not followed. A network
 * error or timeout is retried (PAGE_ATTEMPTS in all), then thrown as a PageNetworkError; an HTTP status is returned
 * as it is.
 */
export const directPage: PageSource = async (channel, before) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(previewUrl(channel, before), {
        headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' },
        redirect: 'manual',
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      })
      const html = await res.text()
      return { status: res.status, html: res.ok ? html : '' }
    } catch (e) {
      if (attempt >= PAGE_ATTEMPTS) {
        const err = e as Error
        throw new PageNetworkError(
          err.name === 'TimeoutError'
            ? `t.me/s/${channel}: no answer in ${PAGE_TIMEOUT_MS / 1000} s (${PAGE_ATTEMPTS} attempts)`
            : err.message,
        )
      }
      await sleep(RETRY_PAUSE_MS)
    }
  }
}

/**
 * Fetches pages through telegram-ingest's ?page relay in `region` (x-region). If the relay itself fails (not
 * Telegram's answer: the relay's network, auth or a 5xx), the page is fetched from here instead, so a relay outage
 * only brings back the region problem for the channels it affects.
 */
export function relayPages(supabaseUrl: string, secret: string, region: string, fallback: PageSource = directPage): PageSource {
  return async (channel, before) => {
    const url = `${supabaseUrl}/functions/v1/telegram-ingest?page=${channel}${before ? `&before=${before}` : ''}`
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'x-ingest-secret': secret, 'x-region': region } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json() as RawPage
      if (typeof body?.status !== 'number' || typeof body.html !== 'string') throw new Error('unexpected answer')
      return body
    } catch (e) {
      console.error(`telegram page relay (${region}) failed for ${channel}, fetching here:`, (e as Error).message)
      return fallback(channel, before)
    }
  }
}

let pageSource: PageSource = directPage
/** Sets where fetchPage gets pages from (mcp: relayPages). Default: directPage. */
export function setPageSource(source: PageSource) {
  pageSource = source
}

/** Fetches one preview page. Returns null when the channel has no public preview (missing, private, or turned off). */
export async function fetchPage(channel: string, before?: number): Promise<TgPage | null> {
  const { status, html } = await pageSource(channel, before)
  if (status >= 300 && status < 400) return null // no preview: t.me/s/<name> redirects to t.me/<name>
  if (status < 200 || status >= 300) throw new Error(`t.me/s/${channel}: HTTP ${status}`)
  const page = parsePage(html, channel)
  const problems = pageProblems(html, page, channel)
  if (problems.length) throw new Error(`t.me/s/${channel}: ${problems.join('; ')}`)
  return page
}

/**
 * Problems with a parsed preview page, empty when it looks right. The preview is HTML, not an API: when Telegram renames
 * a CSS class, parsePage doesn't fail, it finds fewer posts or empty text. The post markers (data-post="<channel>/<id>")
 * are counted straight from the HTML, independently of the class names parsePage relies on.
 */
export function pageProblems(html: string, page: TgPage, channel: string): string[] {
  const problems: string[] = []
  const esc = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const markers = new Set(html.match(new RegExp(`data-post="${esc}/\\d+"`, 'gi')) ?? []).size
  if (markers > 0 && page.posts.length < markers * 0.8) {
    problems.push(`parsed ${page.posts.length} of ${markers} posts on the page (page format changed?)`)
  }
  const blank = page.posts.filter((p) => !p.text && !p.has_media).length
  if (page.posts.length >= 5 && blank > page.posts.length / 2) {
    problems.push(`${blank} of ${page.posts.length} posts have no text and no media (text format changed?)`)
  }
  return problems
}

export function parsePage(html: string, channel: string): TgPage {
  // linkedom ships loose DOM typings, so the parsed document is typed as any here
  // deno-lint-ignore no-explicit-any
  const { document } = parseHTML(html) as unknown as { document: any }
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? null
  const posts: TgPost[] = []
  for (const el of document.querySelectorAll('.tgme_widget_message[data-post]')) {
    const [owner, id] = (el.getAttribute('data-post') ?? '').split('/')
    if (owner?.toLowerCase() !== channel || !/^\d+$/.test(id ?? '')) continue // e.g. a post embedded from elsewhere
    const bubble = el.querySelector('.tgme_widget_message_bubble')
    // The post's own text is a direct child of the bubble; a quoted reply has its own nested text block. Posts the
    // preview can't fully show (text_not_supported_wrap: custom emoji, some media) put it one level down, in
    // media_supported_cont, next to a "Please open Telegram" notice (log 2026-11-20, @stockbot).
    // deno-lint-ignore no-explicit-any
    const child = (parent: any, cls: string) => parent ? [...parent.children].find((c: any) => c.classList.contains(cls)) : null
    const textEl = child(bubble, 'tgme_widget_message_text') ??
      child(child(bubble, 'media_supported_cont'), 'tgme_widget_message_text')
    let text = ''
    const links: string[] = []
    if (textEl) {
      for (const br of textEl.querySelectorAll('br')) br.replaceWith('\n')
      for (const a of textEl.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href')!
        if (/^https?:/.test(href) && !links.includes(href)) links.push(href)
      }
      text = (textEl.textContent ?? '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim()
    }
    // Text outside the post's own text block, appended in brackets: a link preview (site · title, then its
    // description), a document's title, a poll (question and options). Left out on purpose: a quoted reply (another
    // post's text), poll percentages (they change with every vote, and a changed text re-gates the post), file sizes
    // and "Anonymous Poll" (UI). Checked against every collected channel's live pages (log 2026-11-20).
    // deno-lint-ignore no-explicit-any
    const textOf = (root: any, sel: string): string =>
      ((root?.querySelector(sel)?.textContent ?? '') as string).replace(/ /g, ' ').replace(/\s+/g, ' ').trim()
    const extra: string[] = []
    const preview = el.querySelector('.tgme_widget_message_link_preview')
    if (preview) {
      const head = [textOf(preview, '.link_preview_site_name'), textOf(preview, '.link_preview_title')].filter(Boolean).join(' · ')
      const desc = textOf(preview, '.link_preview_description')
      if (head || desc) extra.push([head && `[${head}]`, desc].filter(Boolean).join('\n'))
    }
    const doc = textOf(el, '.tgme_widget_message_document_title')
    if (doc) extra.push(`[${doc}]`)
    const poll = el.querySelector('.tgme_widget_message_poll')
    if (poll) {
      // deno-lint-ignore no-explicit-any
      const options = [...poll.querySelectorAll('.tgme_widget_message_poll_option_text')].map((o: any) =>
        `- ${(o.textContent ?? '').replace(/\s+/g, ' ').trim()}`
      )
      extra.push([`[poll] ${textOf(poll, '.tgme_widget_message_poll_question')}`, ...options].join('\n'))
    }
    if (extra.length) text = [text, ...extra].filter(Boolean).join('\n')

    const ts = el.querySelector('.tgme_widget_message_date time')?.getAttribute('datetime')
    if (!ts) continue
    posts.push({
      msg_id: Number(id),
      ts,
      text,
      views: parseViews(el.querySelector('.tgme_widget_message_views')?.textContent),
      forwarded_from: el.querySelector('.tgme_widget_message_forwarded_from_name')?.textContent?.trim() || null,
      has_media: !!el.querySelector(
        '.tgme_widget_message_photo_wrap, .tgme_widget_message_video_player, .tgme_widget_message_document, .tgme_widget_message_roundvideo_player',
      ),
      links,
      edited: /edited/i.test(el.querySelector('.tgme_widget_message_meta')?.textContent ?? ''),
    })
  }
  return { title, posts }
}

// ---- Sync ----

export type SyncResult = {
  channel: string
  ok: boolean
  new_posts: number
  pages: number
  error?: string
  unreachable?: boolean // failed because t.me gave no answer at all (PageNetworkError), not a page problem
  backfill_pending?: boolean // a first sync stopped at maxPages before sinceTs: backfillChannel fetches the rest
}

/**
 * Stores posts from one page. Posts are stored untagged: the gate (telegram-ingest, ./gate.ts) labels and tags them
 * afterwards, and the upserts never touch its columns, so a page fetched again keeps its tags. `seen` posts only get
 * views/text refreshed; a post that parses empty now (format change, or a caption-less edit) keeps its stored text.
 * A changed text is gated again (a trigger resets gated_at).
 */
async function storePosts(supabase: SupabaseClient, channel: string, fresh: TgPost[], seen: TgPost[]) {
  if (fresh.length) {
    const rows = fresh.map((p) => ({ username: channel, ...p }))
    const { error } = await supabase.from('telegram_messages').upsert(rows, { onConflict: 'username,msg_id' })
    if (error) throw new Error(`save posts: ${error.message}`)
  }
  const withText = seen.filter((p) => p.text).map((p) => ({ username: channel, ...p }))
  const noText = seen.filter((p) => !p.text).map(({ text: _t, ...p }) => ({ username: channel, ...p }))
  for (const rows of [withText, noText]) {
    if (!rows.length) continue
    const { error } = await supabase.from('telegram_messages').upsert(rows, { onConflict: 'username,msg_id' })
    if (error) throw new Error(`update posts: ${error.message}`)
  }
}

const oldestOf = (posts: TgPost[]) => posts.reduce((a, p) => (p.msg_id < a.msg_id ? p : a))

/**
 * Fetches a channel's newest page and, if there's a gap since the last poll, earlier pages until it reaches posts we
 * already have (or `sinceTs` for a first backfill), up to `maxPages`. Upserts the posts (views change over time) and
 * updates the channel's poll state.
 *
 * A first sync (no posts yet) with `sinceTs` that stops at `maxPages` before reaching it records a pending backfill
 * (backfill_* columns), for backfillChannel to continue from the oldest post fetched. `firstPage`: the newest page,
 * when the caller already fetched it (add_telegram_channel's public-preview check), so it isn't fetched twice.
 */
export async function syncChannel(
  supabase: SupabaseClient,
  channel: string,
  opts: { sinceTs?: string; maxPages?: number; firstPage?: TgPage } = {},
): Promise<SyncResult> {
  const maxPages = opts.maxPages ?? 5
  const { data: ch } = await supabase.from('telegram_channels').select('last_msg_id').eq('username', channel).single()
  const known = ch?.last_msg_id ?? 0
  let pages = 0
  let newest = known
  let newPosts = 0
  let before: number | undefined
  let title: string | null = null
  let oldest: TgPost | null = null
  let complete = false // stopped because it reached known posts, sinceTs or the channel's first post (not maxPages)
  try {
    while (pages < maxPages) {
      let page: TgPage | null
      if (pages === 0 && opts.firstPage) page = opts.firstPage
      else {
        if (pages > 0) await sleep(PAGE_PAUSE_MS)
        page = await fetchPage(channel, before)
      }
      pages++
      if (!page) throw new Error('no public preview (channel missing, private, or preview turned off)')
      title ??= page.title
      // The newest page of a channel we've collected from can't be empty: posts didn't vanish, the parser lost them
      if (page.posts.length === 0 && pages === 1 && known > 0) {
        throw new Error('no posts parsed on the newest page, but the channel had posts before (page format changed?)')
      }
      if (page.posts.length === 0) { complete = true; break }
      const fresh = page.posts.filter((p) => p.msg_id > known)
      await storePosts(supabase, channel, fresh, page.posts.filter((p) => p.msg_id <= known))
      newPosts += fresh.length
      newest = Math.max(newest, ...page.posts.map((p) => p.msg_id))
      oldest = oldestOf(page.posts)
      const reachedKnown = known > 0 && oldest.msg_id <= known
      const reachedSince = !known && (!opts.sinceTs || oldest.ts <= opts.sinceTs)
      if (reachedKnown || reachedSince || oldest.msg_id <= 1) { complete = true; break }
      before = oldest.msg_id
    }
    const backfill = !known && !!opts.sinceTs && !complete && oldest != null
    await supabase.from('telegram_channels').update({
      ...(title ? { title } : {}),
      last_msg_id: newest || null,
      last_polled_at: new Date().toISOString(),
      last_error: null,
      poll_errors: 0,
      ...(backfill
        ? {
          backfill_before: oldest!.msg_id,
          backfill_oldest_ts: oldest!.ts,
          backfill_since: opts.sinceTs,
          backfill_pages: pages,
          backfill_at: new Date().toISOString(),
        }
        : {}),
    }).eq('username', channel)
    return { channel, ok: true, new_posts: newPosts, pages, ...(backfill ? { backfill_pending: true } : {}) }
  } catch (e) {
    const msg = readableError((e as Error).message) // an HTML error page from a gateway becomes its title
    const { data: cur } = await supabase.from('telegram_channels').select('poll_errors').eq('username', channel).single()
    await supabase.from('telegram_channels').update({
      last_polled_at: new Date().toISOString(),
      last_error: msg.slice(0, 500),
      poll_errors: (cur?.poll_errors ?? 0) + 1,
    }).eq('username', channel)
    const unreachable = e instanceof PageNetworkError
    return { channel, ok: false, new_posts: newPosts, pages, error: msg, ...(unreachable ? { unreachable } : {}) }
  }
}

// ---- Backfill ----

export type BackfillResult = {
  channel: string
  ok: boolean
  pages: number // fetched in this call
  new_posts: number
  done: boolean // nothing left to backfill (or nothing was pending)
  skipped?: string // not run: why
  error?: string
}

const DONE = { backfill_before: null, backfill_oldest_ts: null, backfill_since: null }

/**
 * Continues a channel's pending backfill (recorded by syncChannel): pages of older posts before backfill_before, until
 * posts reach backfill_since, the channel's first post, or BACKFILL_MAX_PAGES pages in all (the first sync's included).
 * Progress is saved after every page, so an interrupted backfill resumes where it stopped.
 *
 * `resume`: called by telegram-ingest for backfills that may have been interrupted. It first claims the backfill
 * (no progress for BACKFILL_STALE_MS), so it never runs alongside the background backfill that is still going.
 * A failed page still counts towards the page cap, so a channel that keeps failing stops being retried.
 */
export async function backfillChannel(
  supabase: SupabaseClient,
  channel: string,
  opts: { resume?: boolean; pauseMs?: number } = {},
): Promise<BackfillResult> {
  const pauseMs = opts.pauseMs ?? PAGE_PAUSE_MS
  const result: BackfillResult = { channel, ok: true, pages: 0, new_posts: 0, done: false }
  if (opts.resume) {
    const stale = new Date(Date.now() - BACKFILL_STALE_MS).toISOString()
    const { data: claimed, error } = await supabase.from('telegram_channels')
      .update({ backfill_at: new Date().toISOString() })
      .eq('username', channel).not('backfill_before', 'is', null).or(`backfill_at.is.null,backfill_at.lt.${stale}`)
      .select('username')
    if (error) return { ...result, ok: false, error: error.message }
    if (!claimed?.length) return { ...result, skipped: 'no stalled backfill (done, or still running)' }
  }
  const { data: st, error: stErr } = await supabase.from('telegram_channels')
    .select('backfill_before, backfill_since, backfill_pages').eq('username', channel).single()
  if (stErr) return { ...result, ok: false, error: stErr.message }
  if (st.backfill_before == null) return { ...result, done: true, skipped: 'no backfill pending' }

  let before: number = st.backfill_before
  let pages: number = st.backfill_pages
  const finish = async (fields: Record<string, unknown>) => {
    const { error } = await supabase.from('telegram_channels')
      .update({ ...fields, backfill_pages: pages, backfill_at: new Date().toISOString() }).eq('username', channel)
    if (error) throw new Error(`save backfill state: ${error.message}`)
  }
  try {
    while (pages < BACKFILL_MAX_PAGES) {
      await sleep(pauseMs) // polite: the previous page (the first sync's, or this loop's) was just fetched
      pages++
      result.pages++
      const page = await fetchPage(channel, before)
      if (!page) throw new Error('no public preview (channel missing, private, or preview turned off)')
      if (page.posts.length === 0) {
        await finish(DONE)
        return { ...result, done: true }
      }
      // Older than anything stored; a page fetched again after an interruption is upserted the same way
      await storePosts(supabase, channel, page.posts, [])
      result.new_posts += page.posts.length
      const oldest = oldestOf(page.posts)
      // As dates: post times are t.me's datetime attribute, backfill_since is Postgres's rendering
      if (Date.parse(oldest.ts) <= Date.parse(st.backfill_since) || oldest.msg_id <= 1) {
        await finish(DONE)
        return { ...result, done: true }
      }
      before = oldest.msg_id
      await finish({ backfill_before: before, backfill_oldest_ts: oldest.ts })
    }
    await finish(DONE) // page cap: a busy channel keeps less than 30 days
    return { ...result, done: true }
  } catch (e) {
    const msg = readableError((e as Error).message)
    try {
      await finish(pages >= BACKFILL_MAX_PAGES ? DONE : {})
    } catch { /* the state is saved after every page; at worst this page is retried */ }
    return { ...result, ok: false, done: pages >= BACKFILL_MAX_PAGES, error: msg }
  }
}
