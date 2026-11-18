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

/** Fetches one preview page. Returns null when the channel has no public preview (missing, private, or turned off). */
export async function fetchPage(channel: string, before?: number): Promise<TgPage | null> {
  const url = `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en;q=0.8' }, redirect: 'manual' })
  if (res.status >= 300 && res.status < 400) return null // no preview: t.me/s/<name> redirects to t.me/<name>
  if (!res.ok) throw new Error(`t.me/s/${channel}: HTTP ${res.status}`)
  const html = await res.text()
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
    // The post's own text is a direct child of the bubble; a quoted reply has its own nested text block.
    const textEl = bubble
      ? // deno-lint-ignore no-explicit-any
      [...bubble.children].find((c: any) => c.classList.contains('tgme_widget_message_text'))
      : null
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
    // Link previews and documents carry useful titles even when the post itself has little text
    const extra = [
      el.querySelector('.link_preview_title')?.textContent,
      el.querySelector('.tgme_widget_message_document_title')?.textContent,
    ].filter((t): t is string => !!t?.trim())
    if (extra.length) text = [text, ...extra.map((t) => `[${t.trim()}]`)].filter(Boolean).join('\n')

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

// ---- Stock tagging ----
// Stock names are matched as plain substrings, longest first. Names shorter than 3 characters are skipped because they
// collide with ordinary words (e.g. 대상, 한국), and 6-digit codes are matched directly.

export type StockIndex = { names: [string, string][]; codes: Set<string> }

// Cached per function instance: the stock list changes at most once a day, and loading ~2,800 names takes a few
// round trips. Callers that may not need it (a poll with no new posts) pass stockIndex as a lazy getter.
const INDEX_TTL_MS = 6 * 3600_000
let cachedIndex: { idx: StockIndex; at: number } | null = null

export async function stockIndex(supabase: SupabaseClient): Promise<StockIndex> {
  if (cachedIndex && Date.now() - cachedIndex.at < INDEX_TTL_MS) return cachedIndex.idx
  cachedIndex = { idx: await loadStockIndex(supabase), at: Date.now() }
  return cachedIndex.idx
}

export async function loadStockIndex(supabase: SupabaseClient): Promise<StockIndex> {
  const { data: last, error: e1 } = await supabase
    .from('available_dates').select('bas_dd').order('bas_dd', { ascending: false }).limit(1)
  if (e1) throw new Error(e1.message)
  const stocks: { isu_cd: string; isu_nm: string }[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('prices').select('isu_cd, isu_nm').eq('bas_dd', last?.[0]?.bas_dd).order('isu_cd').range(from, from + 999)
    if (error) throw new Error(error.message)
    stocks.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return buildStockIndex(stocks)
}

// Nicknames for a few large caps, matched like names (whole words) and allowed under 3 characters because each was
// chosen by hand. Checked against the stock list (2026-11-18); an alias whose code isn't listed is ignored. Left out
// on purpose: 포스코 (several POSCO companies). After changing this list, retag (telegram-ingest?retag=1).
export const STOCK_ALIASES: [alias: string, code: string][] = [
  ['삼전', '005930'], // 삼성전자
  ['하닉', '000660'], // SK하이닉스
  ['하이닉스', '000660'],
  ['엘엔솔', '373220'], // LG에너지솔루션
  ['엘지엔솔', '373220'],
  ['LG엔솔', '373220'],
  ['현차', '005380'], // 현대차
  ['기아차', '000270'], // 기아 (its name until 2021)
  ['삼바', '207940'], // 삼성바이오로직스
  ['셀트', '068270'], // 셀트리온
  ['카뱅', '323410'], // 카카오뱅크
  ['한화에어로', '012450'], // 한화에어로스페이스
  ['에코비엠', '247540'], // 에코프로비엠
  ['두산에너빌', '034020'], // 두산에너빌리티
  ['네이버', '035420'], // NAVER
]

export function buildStockIndex(
  stocks: { isu_cd: string; isu_nm: string }[],
  aliases: [string, string][] = STOCK_ALIASES,
): StockIndex {
  const names: [string, string][] = []
  const codes = new Set<string>()
  for (const r of stocks) {
    codes.add(r.isu_cd)
    if ([...r.isu_nm].length < 3) continue
    names.push([r.isu_nm, r.isu_cd])
    // Group prefixes are often written with a space: SK 하이닉스, LG 에너지솔루션
    const m = r.isu_nm.match(/^([A-Z&]+)(\p{Script=Hangul}.*)$/u)
    if (m) names.push([`${m[1]} ${m[2]}`, r.isu_cd])
  }
  for (const [alias, code] of aliases) if (codes.has(code)) names.push([alias, code])
  names.sort((a, b) => b[0].length - a[0].length) // longest first, so 삼성전자우 is checked before 삼성전자
  return { names, codes }
}

// A name only counts as a whole word: not glued to letters before it, and followed by a space, punctuation, or a
// Korean particle. Otherwise 퀀텀스케이프 would tag 케이프, 하이브리드 하이브, and 아스트라제네카 아스트.
const LETTER = /[\p{L}\p{N}]/u
const PARTICLES = [
  '으로', '에서', '에게', '까지', '부터', '보다', '처럼', '대비', '주가', '이다', '였다',
  '은', '는', '이', '가', '을', '를', '의', '와', '과', '도', '에', '로', '만', '측', '향', '등', '및', '株', '랑',
  'ADR', 'GDR', // depositary receipts: SK하이닉스ADR is still SK하이닉스
]

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = text[start - 1]
  if (before && LETTER.test(before)) return false
  const after = text.slice(end)
  if (!after || !LETTER.test(after[0])) return true
  return PARTICLES.some((p) => after.startsWith(p))
}

export function tagStocks(text: string, idx: StockIndex): string[] {
  const found = new Set<string>()
  let rest = text
  for (const [name, code] of idx.names) {
    let from = 0
    for (let i = rest.indexOf(name, from); i !== -1; i = rest.indexOf(name, from)) {
      from = i + name.length
      if (!isWholeWord(rest, i, from)) continue
      found.add(code)
      // a matched name consumes its text, so 삼성전자우 doesn't also tag 삼성전자
      rest = rest.slice(0, i) + ' '.repeat(name.length) + rest.slice(from)
    }
  }
  // Codes: 6 characters, mostly digits, but 96 listed stocks have a letter (0001A0, 00088K). Only listed codes count,
  // so a 6-letter word like NVIDIA never matches.
  for (const m of text.matchAll(/(?<![0-9A-Za-z])([0-9A-Z]{6})(?![0-9A-Za-z])/g)) if (idx.codes.has(m[1])) found.add(m[1])
  return [...found]
}

// ---- Sync ----

export type SyncResult = {
  channel: string
  ok: boolean
  new_posts: number
  pages: number
  error?: string
  backfill_pending?: boolean // a first sync stopped at maxPages before sinceTs: backfillChannel fetches the rest
}

/**
 * Stores posts from one page. `fresh` posts are new to us and get stock tags (the stock index is only loaded when
 * there are any). `seen` posts only get views/text refreshed: leaving stock_codes out of the upsert keeps their tags,
 * and a post that parses empty now (format change, or a caption-less edit) keeps its stored text.
 */
async function storePosts(
  supabase: SupabaseClient,
  channel: string,
  fresh: TgPost[],
  seen: TgPost[],
  getIndex: () => Promise<StockIndex>,
) {
  if (fresh.length) {
    const idx = await getIndex()
    const rows = fresh.map((p) => ({ username: channel, ...p, stock_codes: tagStocks(p.text, idx) }))
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
  getIndex: () => Promise<StockIndex>,
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
      await storePosts(supabase, channel, fresh, page.posts.filter((p) => p.msg_id <= known), getIndex)
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
    return { channel, ok: false, new_posts: newPosts, pages, error: msg }
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
  getIndex: () => Promise<StockIndex>,
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
      // These are older than anything stored, so all are tagged; a page fetched again after an interruption just
      // gets the same tags again
      await storePosts(supabase, channel, page.posts, [], getIndex)
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
