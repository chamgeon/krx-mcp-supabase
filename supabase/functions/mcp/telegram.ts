// MCP tools for public Telegram channels: add a channel on request, list channels, read a feed, search posts.
// Collection lives in ../_shared/telegram.ts; scheduled polling in ../telegram-ingest.

import type { McpServer } from 'npm:@modelcontextprotocol/server@^2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@^4.3.6'
import { channelName, fetchPage, loadStockIndex, syncChannel } from '../_shared/telegram.ts'

const MAX_CHANNELS = 50 // cap on shared collection, so open adding can't turn the server into a crawler
const BACKFILL_DAYS = 30
const BACKFILL_MAX_PAGES = 8 // 20 posts per page
const STALE_MS = 5 * 60_000 // refresh a channel before reading it if its last poll is older than this

type Msg = {
  username: string
  msg_id: number
  ts: string
  text: string
  views: number | null
  forwarded_from: string | null
  has_media: boolean
  links: string[]
  stock_codes: string[]
}

const MSG_COLUMNS = 'username, msg_id, ts, text, views, forwarded_from, has_media, links, stock_codes'

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}
function kst(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') + ' KST'
}
function sinceIso(since: string | undefined, defaultDays: number): string {
  if (!since) return new Date(Date.now() - defaultDays * 86400_000).toISOString()
  const s = since.replace(/-/g, '')
  if (/^\d{8}$/.test(s)) return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00+09:00`).toISOString()
  const d = new Date(since)
  if (isNaN(d.getTime())) throw new Error(`since: not a date (${since})`)
  return d.toISOString()
}

export function registerTelegramTools(server: McpServer, supabase: SupabaseClient, userId: string | null) {
  // 종목코드 → 종목명 for the codes in a result set (latest trading day)
  async function stockNames(codes: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(codes)]
    if (!uniq.length) return new Map()
    const { data: last } = await supabase.from('available_dates').select('bas_dd').order('bas_dd', { ascending: false }).limit(1)
    const { data } = await supabase.from('prices').select('isu_cd, isu_nm').eq('bas_dd', last?.[0]?.bas_dd).in('isu_cd', uniq)
    return new Map((data ?? []).map((r) => [r.isu_cd, r.isu_nm]))
  }

  async function present(msgs: Msg[], maxChars: number, snippetOf?: (m: Msg) => string) {
    const names = await stockNames(msgs.flatMap((m) => m.stock_codes))
    return msgs.map((m) => ({
      channel: m.username,
      time: kst(m.ts),
      text: snippetOf ? snippetOf(m) : m.text.length > maxChars ? m.text.slice(0, maxChars) + '…' : m.text,
      views: m.views,
      ...(m.forwarded_from ? { forwarded_from: m.forwarded_from } : {}),
      ...(m.has_media ? { has_media: true } : {}),
      ...(m.links.length ? { links: m.links.slice(0, 5) } : {}),
      ...(m.stock_codes.length ? { stocks: m.stock_codes.map((c) => ({ code: c, name: names.get(c) ?? null })) } : {}),
      link: `https://t.me/${m.username}/${m.msg_id}`,
    }))
  }

  // Polls channels whose last poll is older than STALE_MS (one request each), so reads are fresh between cron runs.
  async function refreshStale(channels: string[]) {
    const { data } = await supabase.from('telegram_channels').select('username, last_polled_at').in('username', channels)
    const stale = (data ?? []).filter((c) => !c.last_polled_at || Date.now() - new Date(c.last_polled_at).getTime() > STALE_MS)
    if (!stale.length) return
    const idx = await loadStockIndex(supabase)
    for (const c of stale) await syncChannel(supabase, c.username, idx, { maxPages: 2 })
  }

  async function resolveStock(stock: string): Promise<string | null> {
    const s = stock.trim()
    if (/^\d{6}$/.test(s)) return s
    const { data: last } = await supabase.from('available_dates').select('bas_dd').order('bas_dd', { ascending: false }).limit(1)
    const { data } = await supabase.from('prices').select('isu_cd, isu_nm').eq('bas_dd', last?.[0]?.bas_dd).eq('isu_nm', s).limit(1)
    return data?.[0]?.isu_cd ?? null
  }

  server.registerTool(
    'add_telegram_channel',
    {
      title: '텔레그램 채널 추가',
      description:
        'Starts collecting a public Telegram channel (one with a t.me/s/<name> web preview) for all users, backfills ' +
        `about ${BACKFILL_DAYS} days of posts, and returns the latest ones. After this the channel is polled ` +
        'automatically. Private channels and channels with the preview turned off cannot be added. Accepts @name, ' +
        'name, or a t.me link.',
      inputSchema: z.object({ channel: z.string().min(1).describe('@name, name, or https://t.me/name') }),
    },
    async ({ channel }) => {
      const name = channelName(channel)
      if (!name) return json({ error: `Not a valid Telegram channel name: ${channel}` })

      const { data: existing } = await supabase.from('telegram_channels').select('username, active').eq('username', name)
      if (!existing?.length) {
        const { count } = await supabase.from('telegram_channels').select('*', { count: 'exact', head: true }).eq('active', true)
        if ((count ?? 0) >= MAX_CHANNELS) {
          return json({ error: `The collection limit (${MAX_CHANNELS} channels) is reached. Ask the operator to raise it.` })
        }
        const page = await fetchPage(name)
        if (!page) {
          return json({
            error: `t.me/${name} has no public web preview: it doesn't exist, is private, or the owner turned the ` +
              'preview off. Only public channels can be collected.',
          })
        }
        const { error } = await supabase.from('telegram_channels').insert({ username: name, title: page.title, added_by: userId })
        if (error) throw new Error(error.message)
      } else if (!existing[0].active) {
        await supabase.from('telegram_channels').update({ active: true, poll_errors: 0 }).eq('username', name)
      }

      const idx = await loadStockIndex(supabase)
      const since = new Date(Date.now() - BACKFILL_DAYS * 86400_000).toISOString()
      const sync = await syncChannel(supabase, name, idx, { sinceTs: since, maxPages: BACKFILL_MAX_PAGES })
      if (!sync.ok) return json({ channel: name, error: sync.error })

      const [{ data: ch }, { count }, { data: latest }] = await Promise.all([
        supabase.from('telegram_channels').select('title').eq('username', name).single(),
        supabase.from('telegram_messages').select('*', { count: 'exact', head: true }).eq('username', name),
        supabase.from('telegram_messages').select(MSG_COLUMNS).eq('username', name).order('ts', { ascending: false }).limit(5),
      ])
      return json({
        channel: name,
        title: ch?.title ?? null,
        status: existing?.length ? 'already collected (refreshed)' : 'added',
        posts_stored: count ?? 0,
        latest_posts: await present((latest ?? []) as Msg[], 600),
      })
    },
  )

  server.registerTool(
    'list_telegram_channels',
    {
      title: '수집 중인 텔레그램 채널',
      description: 'Public Telegram channels being collected, with post counts, the latest post time, and poll status.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { data, error } = await supabase.from('telegram_channel_stats').select('*').order('last_post', { ascending: false })
      if (error) throw new Error(error.message)
      return json((data ?? []).map((c) => ({
        channel: c.username,
        title: c.title,
        link: `https://t.me/${c.username}`,
        active: c.active,
        posts: c.posts,
        first_post: c.first_post ? kst(c.first_post) : null,
        last_post: c.last_post ? kst(c.last_post) : null,
        last_polled: c.last_polled_at ? kst(c.last_polled_at) : null,
        ...(c.last_error ? { error: c.last_error } : {}),
      })))
    },
  )

  server.registerTool(
    'get_telegram_feed',
    {
      title: '텔레그램 채널 글',
      description:
        'Recent posts from collected public Telegram channels, newest first, with a link to each post and the stocks ' +
        'mentioned (matched by 종목명 or 종목코드). Filter by channel, by stock, and by time. Channels are refreshed ' +
        'first if their last poll is more than 5 minutes old. Use add_telegram_channel to collect a new channel.',
      inputSchema: z.object({
        channel: z.string().optional().describe('one channel (@name, name, or t.me link); omit for all channels'),
        stock: z.string().optional().describe('종목코드 or exact 종목명: only posts mentioning it'),
        since: z.string().optional().describe('YYYY-MM-DD (KST) or ISO time; default: 3 days ago'),
        limit: z.number().int().min(1).max(100).default(20),
        max_chars: z.number().int().min(100).max(5000).default(1500).describe('truncate each post to this many characters'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ channel, stock, since, limit, max_chars }) => {
      const name = channel ? channelName(channel) : null
      if (channel && !name) return json({ error: `Not a valid Telegram channel name: ${channel}` })
      if (name) {
        const { data } = await supabase.from('telegram_channels').select('username').eq('username', name)
        if (!data?.length) return json({ error: `t.me/${name} isn't collected yet. Call add_telegram_channel first.` })
        await refreshStale([name])
      } else {
        const { data } = await supabase.from('telegram_channels').select('username').eq('active', true)
        if ((data?.length ?? 0) <= 5) await refreshStale((data ?? []).map((c) => c.username))
      }

      let code: string | null = null
      if (stock) {
        code = await resolveStock(stock)
        if (!code) return json({ error: `Unknown stock: ${stock}. Pass a 종목코드 or the exact 종목명 (see find_stock).` })
      }

      let q = supabase.from('telegram_messages').select(MSG_COLUMNS).gte('ts', sinceIso(since, 3))
      if (name) q = q.eq('username', name)
      if (code) q = q.contains('stock_codes', [code])
      const { data, error } = await q.order('ts', { ascending: false }).limit(limit)
      if (error) throw new Error(error.message)
      return json({ count: data?.length ?? 0, posts: await present((data ?? []) as Msg[], max_chars) })
    },
  )

  server.registerTool(
    'search_telegram',
    {
      title: '텔레그램 검색',
      description:
        'Searches collected public Telegram posts for words (all words must appear, case-insensitive substring ' +
        'match, so Korean works). Returns a snippet around the first match and a link to each post, newest first.',
      inputSchema: z.object({
        query: z.string().min(1).describe('words separated by spaces, e.g. "HBM 수주"'),
        channel: z.string().optional(),
        since: z.string().optional().describe('YYYY-MM-DD (KST) or ISO time; default: 30 days ago'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, channel, since, limit }) => {
      const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 5)
      const name = channel ? channelName(channel) : null
      let q = supabase.from('telegram_messages').select(MSG_COLUMNS).gte('ts', sinceIso(since, 30))
      if (name) q = q.eq('username', name)
      for (const t of terms) q = q.ilike('text', `%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
      const { data, error } = await q.order('ts', { ascending: false }).limit(limit)
      if (error) throw new Error(error.message)

      const snippet = (m: Msg) => {
        const i = m.text.toLowerCase().indexOf(terms[0].toLowerCase())
        const start = Math.max(0, i - 150)
        const end = Math.min(m.text.length, i + terms[0].length + 250)
        return (start > 0 ? '…' : '') + m.text.slice(start, end) + (end < m.text.length ? '…' : '')
      }
      return json({ query: terms, count: data?.length ?? 0, posts: await present((data ?? []) as Msg[], 0, snippet) })
    },
  )
}
