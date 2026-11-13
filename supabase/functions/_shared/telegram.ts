// Public Telegram channels, read from the web preview at https://t.me/s/<channel>.
//
// No Telegram account or API: the preview page is public HTML with the latest 20 posts, and ?before=<id> pages back
// through older ones. Only channels with the preview turned on can be read (private channels redirect to t.me/<name>).
// Polite by design: one request per channel per poll, a pause between pages, and a cap on backfill pages.
//
// Used by telegram-ingest (scheduled polling) and the MCP tools (add a channel, refresh before reading).

import { parseHTML } from 'npm:linkedom@0.18.5'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

const UA = 'Mozilla/5.0 (compatible; kr-stock-mcp/1.0; public channel reader)'
const PAGE_PAUSE_MS = 800

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
  return parsePage(await res.text(), channel)
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
  const names: [string, string][] = []
  const codes = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('prices').select('isu_cd, isu_nm').eq('bas_dd', last?.[0]?.bas_dd).order('isu_cd').range(from, from + 999)
    if (error) throw new Error(error.message)
    for (const r of data ?? []) {
      codes.add(r.isu_cd)
      if ([...r.isu_nm].length < 3) continue
      names.push([r.isu_nm, r.isu_cd])
      // Group prefixes are often written with a space: SK 하이닉스, LG 에너지솔루션
      const m = r.isu_nm.match(/^([A-Z&]+)(\p{Script=Hangul}.*)$/u)
      if (m) names.push([`${m[1]} ${m[2]}`, r.isu_cd])
    }
    if (!data || data.length < 1000) break
  }
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
  for (const m of text.matchAll(/(?<!\d)(\d{6})(?!\d)/g)) if (idx.codes.has(m[1])) found.add(m[1])
  return [...found]
}

// ---- Sync ----

export type SyncResult = { channel: string; ok: boolean; new_posts: number; pages: number; error?: string }

/**
 * Fetches a channel's newest page and, if there's a gap since the last poll, earlier pages until it reaches posts we
 * already have (or `sinceTs` for a first backfill), up to `maxPages`. Upserts the posts (views change over time) and
 * updates the channel's poll state.
 */
export async function syncChannel(
  supabase: SupabaseClient,
  channel: string,
  getIndex: () => Promise<StockIndex>,
  opts: { sinceTs?: string; maxPages?: number } = {},
): Promise<SyncResult> {
  const maxPages = opts.maxPages ?? 5
  const { data: ch } = await supabase.from('telegram_channels').select('last_msg_id').eq('username', channel).single()
  const known = ch?.last_msg_id ?? 0
  let pages = 0
  let newest = known
  let newPosts = 0
  let before: number | undefined
  let title: string | null = null
  try {
    while (pages < maxPages) {
      if (pages > 0) await sleep(PAGE_PAUSE_MS)
      const page = await fetchPage(channel, before)
      pages++
      if (!page) throw new Error('no public preview (channel missing, private, or preview turned off)')
      title ??= page.title
      if (page.posts.length === 0) break
      // New posts are tagged (the stock index is only loaded when there are any). Posts we already have just get
      // their views/text refreshed: leaving stock_codes out of the upsert keeps their existing tags.
      const fresh = page.posts.filter((p) => p.msg_id > known)
      const seen = page.posts.filter((p) => p.msg_id <= known)
      if (fresh.length) {
        const idx = await getIndex()
        const rows = fresh.map((p) => ({ username: channel, ...p, stock_codes: tagStocks(p.text, idx) }))
        const { error } = await supabase.from('telegram_messages').upsert(rows, { onConflict: 'username,msg_id' })
        if (error) throw new Error(`save posts: ${error.message}`)
      }
      if (seen.length) {
        const rows = seen.map((p) => ({ username: channel, ...p }))
        const { error } = await supabase.from('telegram_messages').upsert(rows, { onConflict: 'username,msg_id' })
        if (error) throw new Error(`update posts: ${error.message}`)
      }
      newPosts += page.posts.filter((p) => p.msg_id > known).length
      newest = Math.max(newest, ...page.posts.map((p) => p.msg_id))
      const oldest = page.posts.reduce((a, p) => (p.msg_id < a.msg_id ? p : a))
      const reachedKnown = known > 0 && oldest.msg_id <= known
      const reachedSince = !known && (!opts.sinceTs || oldest.ts <= opts.sinceTs)
      if (reachedKnown || reachedSince || oldest.msg_id <= 1) break
      before = oldest.msg_id
    }
    await supabase.from('telegram_channels').update({
      ...(title ? { title } : {}),
      last_msg_id: newest || null,
      last_polled_at: new Date().toISOString(),
      last_error: null,
      poll_errors: 0,
    }).eq('username', channel)
    return { channel, ok: true, new_posts: newPosts, pages }
  } catch (e) {
    const msg = (e as Error).message
    const { data: cur } = await supabase.from('telegram_channels').select('poll_errors').eq('username', channel).single()
    await supabase.from('telegram_channels').update({
      last_polled_at: new Date().toISOString(),
      last_error: msg.slice(0, 500),
      poll_errors: (cur?.poll_errors ?? 0) + 1,
    }).eq('username', channel)
    return { channel, ok: false, new_posts: newPosts, pages, error: msg }
  }
}
