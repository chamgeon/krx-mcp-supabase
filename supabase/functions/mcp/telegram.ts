// MCP tools for public Telegram channels: add a channel on request, list channels, read a feed, search posts.
// Collection lives in ../_shared/telegram.ts; scheduled polling in ../telegram-ingest.

import type { McpServer } from 'npm:@modelcontextprotocol/server@^2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@^4.3.6'
import { channelName, fetchPage, stockIndex, syncChannel } from '../_shared/telegram.ts'

const MAX_CHANNELS = 50 // cap on shared collection, so open adding can't turn the server into a crawler
const BACKFILL_DAYS = 30
const BACKFILL_MAX_PAGES = 8 // 20 posts per page
const STALE_MS = 5 * 60_000 // after a read, refresh (in the background) channels last polled longer ago than this

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

// Latest trading day, cached per function instance for a few minutes (it changes once a day). Used to look up
// 종목명 for the stock codes in results.
let latestDay: { day: string | null; at: number } | null = null
async function latestTradingDay(supabase: SupabaseClient): Promise<string | null> {
  if (latestDay && Date.now() - latestDay.at < 5 * 60_000) return latestDay.day
  const { data } = await supabase.from('available_dates').select('bas_dd').order('bas_dd', { ascending: false }).limit(1)
  latestDay = { day: data?.[0]?.bas_dd ?? null, at: Date.now() }
  return latestDay.day
}

// Runs work after the response is sent (Supabase Edge Runtime), so reads never wait for a Telegram fetch.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined
function inBackground(p: Promise<unknown>) {
  const safe = p.catch((e) => console.error('background refresh failed:', (e as Error).message))
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(safe)
}

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
    const { data } = await supabase.from('prices').select('isu_cd, isu_nm').eq('bas_dd', await latestTradingDay(supabase)).in('isu_cd', uniq)
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
    for (const c of stale) await syncChannel(supabase, c.username, () => stockIndex(supabase), { maxPages: 2 })
  }

  // Makes sure a channel is collected: a new one is checked (public preview), saved, and backfilled ~30 days; an
  // inactive one is reactivated. With refresh, an existing channel is also polled now.
  async function ensureChannel(
    name: string,
    opts: { refresh: boolean },
  ): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
    const { data: existing } = await supabase.from('telegram_channels').select('username, active').eq('username', name)
    let status = 'already collected'
    if (!existing?.length) {
      const { count } = await supabase.from('telegram_channels').select('*', { count: 'exact', head: true }).eq('active', true)
      if ((count ?? 0) >= MAX_CHANNELS) {
        return { ok: false, error: `the collection limit (${MAX_CHANNELS} channels) is reached; ask the operator to raise it` }
      }
      const page = await fetchPage(name)
      if (!page) {
        return {
          ok: false,
          error: `t.me/${name} has no public web preview: it doesn't exist, is private, or the owner turned the preview ` +
            'off. Only public channels can be collected.',
        }
      }
      const { error } = await supabase.from('telegram_channels').insert({ username: name, title: page.title, added_by: userId })
      if (error) throw new Error(error.message)
      status = 'added'
    } else if (!existing[0].active) {
      await supabase.from('telegram_channels').update({ active: true, poll_errors: 0 }).eq('username', name)
      status = 'reactivated'
    } else if (!opts.refresh) {
      return { ok: true, status }
    }
    const since = new Date(Date.now() - BACKFILL_DAYS * 86400_000).toISOString()
    const sync = await syncChannel(supabase, name, () => stockIndex(supabase), { sinceTs: since, maxPages: status === 'already collected' ? 2 : BACKFILL_MAX_PAGES })
    if (!sync.ok) return { ok: false, error: sync.error ?? 'sync failed' }
    return { ok: true, status: status === 'already collected' ? 'already collected (refreshed)' : status }
  }

  async function resolveStock(stock: string): Promise<string | null> {
    const s = stock.trim()
    if (/^\d{6}$/.test(s)) return s
    const { data } = await supabase.from('prices').select('isu_cd, isu_nm').eq('bas_dd', await latestTradingDay(supabase)).eq('isu_nm', s).limit(1)
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
      const r = await ensureChannel(name, { refresh: true })
      if (!r.ok) return json({ channel: name, error: r.error })
      const followed = await follow([name])

      const [{ data: ch }, { count }, { data: latest }] = await Promise.all([
        supabase.from('telegram_channels').select('title').eq('username', name).single(),
        supabase.from('telegram_messages').select('*', { count: 'exact', head: true }).eq('username', name),
        supabase.from('telegram_messages').select(MSG_COLUMNS).eq('username', name).order('ts', { ascending: false }).limit(5),
      ])
      return json({
        channel: name,
        title: ch?.title ?? null,
        status: r.status,
        ...(followed ? { followed_by_you: true } : { note: 'Log in (OAuth) to follow channels; the shared URL has no user.' }),
        posts_stored: count ?? 0,
        latest_posts: await present((latest ?? []) as Msg[], 600),
      })
    },
  )

  // ---- Per-user channel preferences (user_channels) ----

  const LOGIN_REQUIRED = {
    error: 'Channel preferences need a logged-in user. This connection uses the shared ?key= URL; reconnect with ' +
      'the plain MCP URL and sign in with Google.',
  }

  async function follow(names: string[]): Promise<boolean> {
    if (!userId || !names.length) return false
    const { error } = await supabase.from('user_channels')
      .upsert(names.map((username) => ({ user_id: userId, username })), { onConflict: 'user_id,username', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
    return true
  }

  async function myChannels(): Promise<string[]> {
    if (!userId) return []
    const { data, error } = await supabase.from('user_channels').select('username').eq('user_id', userId)
    if (error) throw new Error(error.message)
    return (data ?? []).map((r) => r.username)
  }

  async function myChannelsView() {
    const names = await myChannels()
    if (!names.length) return { channels: [], note: 'You follow no channels yet; get_telegram_feed shows all channels.' }
    const { data, error } = await supabase.from('telegram_channel_stats').select('*').in('username', names)
    if (error) throw new Error(error.message)
    return {
      channels: (data ?? []).map((c) => ({
        channel: c.username,
        title: c.title,
        link: `https://t.me/${c.username}`,
        posts: c.posts,
        last_post: c.last_post ? kst(c.last_post) : null,
        ...(c.last_error ? { error: c.last_error } : {}),
      })),
    }
  }

  // Validates names, collects channels that aren't collected yet. Returns the ones that are usable and the failures.
  async function prepare(inputs: string[]) {
    const ok: string[] = []
    const failed: { channel: string; error: string }[] = []
    for (const input of inputs) {
      const name = channelName(input)
      if (!name) { failed.push({ channel: input, error: 'not a valid Telegram channel name' }); continue }
      if (ok.includes(name)) continue
      const r = await ensureChannel(name, { refresh: false })
      if (r.ok) ok.push(name)
      else failed.push({ channel: name, error: r.error })
    }
    return { ok, failed }
  }

  server.registerTool(
    'get_my_channels',
    {
      title: '내 텔레그램 채널',
      description:
        "The Telegram channels the current user follows (their default for get_telegram_feed), with post counts and " +
        'the latest post time. Preferences belong to the logged-in Google account, so they are the same in ChatGPT and ' +
        'Claude.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => (userId ? json(await myChannelsView()) : json(LOGIN_REQUIRED)),
  )

  server.registerTool(
    'set_my_channels',
    {
      title: '내 텔레그램 채널 설정',
      description:
        "Replaces the current user's followed Telegram channels with exactly this list (an empty list clears it). " +
        'Channels not collected yet are added first (public channels with a t.me/s preview only). To add or remove a ' +
        'few, use update_my_channels instead.',
      inputSchema: z.object({ channels: z.array(z.string()).max(50).describe('@name, name, or t.me links') }),
    },
    async ({ channels }) => {
      if (!userId) return json(LOGIN_REQUIRED)
      const { ok, failed } = await prepare(channels)
      const { error } = await supabase.from('user_channels').delete().eq('user_id', userId)
      if (error) throw new Error(error.message)
      await follow(ok)
      return json({ ...(await myChannelsView()), ...(failed.length ? { not_added: failed } : {}) })
    },
  )

  server.registerTool(
    'update_my_channels',
    {
      title: '내 텔레그램 채널 추가/삭제',
      description:
        "Adds and/or removes Telegram channels from the current user's followed list. Channels not collected yet are " +
        'added first (public channels only). Removing a channel only unfollows it; collection continues for others.',
      inputSchema: z.object({
        add: z.array(z.string()).max(50).optional().describe('channels to follow (@name, name, or t.me links)'),
        remove: z.array(z.string()).max(50).optional().describe('channels to unfollow'),
      }),
    },
    async ({ add, remove }) => {
      if (!userId) return json(LOGIN_REQUIRED)
      const { ok, failed } = await prepare(add ?? [])
      await follow(ok)
      const drop = (remove ?? []).map(channelName).filter((n): n is string => !!n)
      if (drop.length) {
        const { error } = await supabase.from('user_channels').delete().eq('user_id', userId).in('username', drop)
        if (error) throw new Error(error.message)
      }
      return json({
        ...(await myChannelsView()),
        ...(ok.length ? { followed: ok } : {}),
        ...(drop.length ? { unfollowed: drop } : {}),
        ...(failed.length ? { not_added: failed } : {}),
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
        'in the background if their last poll is more than 5 minutes old. Without a channel, shows the channels the user follows ' +
        '(get_my_channels), or every collected channel if they follow none or all_channels is true. Use ' +
        'add_telegram_channel to collect a new channel.',
      inputSchema: z.object({
        channel: z.string().optional().describe("one channel (@name, name, or t.me link); omit for the user's channels"),
        all_channels: z.boolean().default(false).describe("every collected channel, not just the user's"),
        stock: z.string().optional().describe('종목코드 or exact 종목명: only posts mentioning it'),
        since: z.string().optional().describe('YYYY-MM-DD (KST) or ISO time; default: 3 days ago'),
        limit: z.number().int().min(1).max(100).default(20),
        max_chars: z.number().int().min(100).max(5000).default(1500).describe('truncate each post to this many characters'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ channel, all_channels, stock, since, limit, max_chars }) => {
      const name = channel ? channelName(channel) : null
      if (channel && !name) return json({ error: `Not a valid Telegram channel name: ${channel}` })
      let scope: string[] | null = null // null = every channel
      let scopeLabel: string
      if (name) {
        const { data } = await supabase.from('telegram_channels').select('username').eq('username', name)
        if (!data?.length) return json({ error: `t.me/${name} isn't collected yet. Call add_telegram_channel first.` })
        scope = [name]
        scopeLabel = name
      } else {
        const mine = all_channels ? [] : await myChannels()
        if (mine.length) {
          scope = mine
          scopeLabel = `your channels (${mine.length})`
        } else {
          scopeLabel = 'all collected channels'
        }
      }
      // Answer from stored posts now (telegram-ingest keeps them within one cron interval) and refresh stale channels
      // after the response, so the next read is fresh without this one waiting on Telegram.
      if (scope) inBackground(refreshStale(scope))

      let code: string | null = null
      if (stock) {
        code = await resolveStock(stock)
        if (!code) return json({ error: `Unknown stock: ${stock}. Pass a 종목코드 or the exact 종목명 (see find_stock).` })
      }

      let q = supabase.from('telegram_messages').select(MSG_COLUMNS).gte('ts', sinceIso(since, 3))
      if (scope) q = q.in('username', scope)
      if (code) q = q.contains('stock_codes', [code])
      const { data, error } = await q.order('ts', { ascending: false }).limit(limit)
      if (error) throw new Error(error.message)
      return json({ scope: scopeLabel, count: data?.length ?? 0, posts: await present((data ?? []) as Msg[], max_chars) })
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
