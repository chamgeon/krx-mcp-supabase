// MCP tools for public Telegram channels: add a channel on request, list channels, read a feed, search posts.
// Collection lives in ../_shared/telegram.ts; scheduled polling in ../telegram-ingest.

import type { McpServer } from 'npm:@modelcontextprotocol/server@^2.0.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { z } from 'npm:zod@^4.3.6'
import {
  BACKFILL_DAYS, BACKFILL_MAX_PAGES, backfillChannel, channelName, fetchPage, stockIndex, syncChannel, type TgPage,
} from '../_shared/telegram.ts'
import { early, step } from './timing.ts'

const MAX_CHANNELS = 50 // cap on shared collection, so open adding can't turn the server into a crawler

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined

// Background backfills of newly added channels, one after another (one t.me request at a time, as in telegram-ingest),
// after the response. The worker is kept alive for them (EdgeRuntime.waitUntil); if it ends first, telegram-ingest
// resumes the backfill from its saved progress.
let backfillQueue: Promise<unknown> = Promise.resolve()
function backfillInBackground(supabase: SupabaseClient, name: string) {
  backfillQueue = backfillQueue
    .then(() => backfillChannel(supabase, name, () => stockIndex(supabase)))
    .then((r) => { if (!r.ok) console.error(`backfill ${name}: ${r.error}`) })
    .catch((e) => console.error(`backfill ${name}: ${(e as Error).message}`))
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(backfillQueue)
}

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

// A telegram_feed row: a post plus its channel's counts in the window (the same on every row of a channel)
type FeedRow = Msg & { is_today: boolean; in_window: number; today: number }

/** Per channel in a feed answer: posts shown, posts today (KST) and in the whole window; busiest first. */
export function feedChannels(rows: FeedRow[]) {
  const by = new Map<string, { channel: string; shown: number; shown_today: number; today: number; in_window: number }>()
  for (const r of rows) {
    const c = by.get(r.username) ?? { channel: r.username, shown: 0, shown_today: 0, today: r.today, in_window: r.in_window }
    c.shown++
    if (r.is_today) c.shown_today++
    by.set(r.username, c)
  }
  return [...by.values()].sort((a, b) => b.in_window - a.in_window || a.channel.localeCompare(b.channel))
}

// Latest trading day, cached per function instance for a few minutes (it changes once a day). Used to look up
// 종목명 for the stock codes in results.
let latestDay: { day: string | null; at: number } | null = null
async function latestTradingDay(supabase: SupabaseClient): Promise<string | null> {
  if (latestDay && Date.now() - latestDay.at < 5 * 60_000) return latestDay.day
  const { data } = await step('latest_trading_day', supabase.from('available_dates').select('bas_dd').order('bas_dd', { ascending: false }).limit(1))
  latestDay = { day: data?.[0]?.bas_dd ?? null, at: Date.now() }
  return latestDay.day
}


function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}
function kst(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') + ' KST'
}
export function sinceIso(since: string | undefined, defaultDays: number): string {
  if (!since) return new Date(Date.now() - defaultDays * 86400_000).toISOString()
  const s = since.replace(/-/g, '')
  if (/^\d{8}$/.test(s)) return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00+09:00`).toISOString()
  const d = new Date(since)
  if (isNaN(d.getTime())) throw new Error(`since: not a date (${since})`)
  return d.toISOString()
}

export function registerTelegramTools(server: McpServer, supabase: SupabaseClient, userId: string | null) {
  // The latest trading day is needed for 종목명 lookups, and depends on nothing, so tools start it first:
  // const day = early(latestTradingDay(supabase)), and pass the promise on.
  type Day = Promise<string | null>

  // 종목코드 → 종목명 for the codes in a result set (latest trading day)
  async function stockNames(codes: string[], dayP: Day): Promise<Map<string, string>> {
    const uniq = [...new Set(codes)]
    if (!uniq.length) return new Map()
    const day = await dayP
    const { data } = await step('stock_names', supabase.from('prices').select('isu_cd, isu_nm').eq('bas_dd', day).in('isu_cd', uniq))
    return new Map((data ?? []).map((r) => [r.isu_cd, r.isu_nm]))
  }

  async function present(msgs: Msg[], maxChars: number, day: Day, snippetOf?: (m: Msg) => string) {
    const names = await stockNames(msgs.flatMap((m) => m.stock_codes), day)
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

  // Makes sure a channel is collected: a new one is checked (public preview) and saved with its newest page, and the
  // rest of ~30 days is backfilled in the background; an inactive one is reactivated. With refresh, an existing
  // channel is also polled now.
  async function ensureChannel(
    name: string,
    opts: { refresh: boolean },
  ): Promise<{ ok: true; status: string; backfilling?: boolean } | { ok: false; error: string }> {
    // Timed steps (tool_calls.timings): tg_* are requests to t.me; tg_sync stores the page (and, for an existing
    // channel, fetches it). The background backfill runs after the call and isn't part of its time.
    const { data: existing } = await step('channel_lookup', supabase.from('telegram_channels').select('username, active').eq('username', name))
    let status = 'already collected'
    let firstPage: TgPage | undefined
    if (!existing?.length) {
      const { count } = await step('channel_count', supabase.from('telegram_channels').select('*', { count: 'exact', head: true }).eq('active', true))
      if ((count ?? 0) >= MAX_CHANNELS) {
        return { ok: false, error: `the collection limit (${MAX_CHANNELS} channels) is reached; ask the operator to raise it` }
      }
      const page = await step('tg_fetch_page', fetchPage(name))
      if (!page) {
        return {
          ok: false,
          error: `t.me/${name} has no public web preview: it doesn't exist, is private, or the owner turned the preview ` +
            'off. Only public channels can be collected.',
        }
      }
      const { error } = await step('channel_insert', supabase.from('telegram_channels').insert({ username: name, title: page.title, added_by: userId }))
      if (error) throw new Error(error.message)
      status = 'added'
      firstPage = page
    } else if (!existing[0].active) {
      await step('channel_reactivate', supabase.from('telegram_channels').update({ active: true, poll_errors: 0 }).eq('username', name))
      status = 'reactivated'
    } else if (!opts.refresh) {
      return { ok: true, status }
    }
    const since = new Date(Date.now() - BACKFILL_DAYS * 86400_000).toISOString()
    // added: only the page already fetched, the rest in the background. reactivated: catches up on the gap since it
    // was last polled (newer posts, not a backfill). already collected: a quick refresh.
    const maxPages = status === 'added' ? 1 : status === 'reactivated' ? BACKFILL_MAX_PAGES : 2
    const sync = await step('tg_sync', syncChannel(supabase, name, () => stockIndex(supabase), { sinceTs: since, maxPages, firstPage }))
    if (!sync.ok) return { ok: false, error: sync.error ?? 'sync failed' }
    if (sync.backfill_pending) backfillInBackground(supabase, name)
    return {
      ok: true,
      status: status === 'already collected' ? 'already collected (refreshed)' : status,
      ...(sync.backfill_pending ? { backfilling: true } : {}),
    }
  }

  // Channels whose older posts are still being collected, and that a request for posts since `sinceTs` needs: the
  // window starts before the oldest post stored so far. scope: channel names, or null for every channel.
  async function stillCollecting(scope: string[] | null, sinceTs: string) {
    let q = supabase.from('telegram_channels').select('username, backfill_oldest_ts').not('backfill_before', 'is', null)
    if (scope) q = q.in('username', scope)
    const { data, error } = await step('backfill_state', q)
    if (error) throw new Error(error.message)
    return (data ?? [])
      .filter((c) => c.backfill_oldest_ts && sinceTs < new Date(c.backfill_oldest_ts).toISOString())
      .map((c) => ({ channel: c.username, collected_from: kst(c.backfill_oldest_ts) }))
  }
  const COLLECTING_NOTE = 'These channels were added moments ago and their older posts are still being collected in ' +
    'the background (usually under a minute). Posts before collected_from are missing from this answer; ask again ' +
    'shortly for the full period.'
  const withCollecting = (pending: { channel: string; collected_from: string }[]) =>
    pending.length ? { still_collecting: pending, still_collecting_note: COLLECTING_NOTE } : {}


  async function resolveStock(stock: string, dayP: Day): Promise<string | null> {
    const s = stock.trim()
    if (/^\d{6}$/.test(s)) return s
    const day = await dayP
    const { data } = await step('resolve_stock', supabase.from('prices').select('isu_cd, isu_nm').eq('bas_dd', day).eq('isu_nm', s).limit(1))
    return data?.[0]?.isu_cd ?? null
  }

  server.registerTool(
    'add_telegram_channel',
    {
      title: '텔레그램 채널 추가',
      description:
        'Starts collecting a public Telegram channel (one with a t.me/s/<name> web preview) for all users and returns ' +
        `its latest posts. About ${BACKFILL_DAYS} days of older posts are collected in the background right after ` +
        '(usually under a minute; get_telegram_feed and search_telegram say when a channel is still filling). After ' +
        'this the channel is polled automatically. Private channels and channels with the preview turned off cannot be added. Accepts @name, ' +
        'name, or a t.me link.',
      inputSchema: z.object({ channel: z.string().min(1).describe('@name, name, or https://t.me/name') }),
    },
    async ({ channel }) => {
      const name = channelName(channel)
      if (!name) return json({ error: `Not a valid Telegram channel name: ${channel}` })
      const day = early(latestTradingDay(supabase))
      const r = await ensureChannel(name, { refresh: true })
      if (!r.ok) return json({ channel: name, error: r.error })

      const [followed, { data: ch }, { count }, { data: latest }] = await Promise.all([
        step('follow', follow([name])),
        step('channel_title', supabase.from('telegram_channels').select('title').eq('username', name).single()),
        step('posts_count', supabase.from('telegram_messages').select('*', { count: 'exact', head: true }).eq('username', name)),
        step('latest_posts', supabase.from('telegram_messages').select(MSG_COLUMNS).eq('username', name).order('ts', { ascending: false }).limit(5)),
      ])
      return json({
        channel: name,
        title: ch?.title ?? null,
        status: r.status,
        ...(followed ? { followed_by_you: true } : { note: 'Log in (OAuth) to follow channels; the shared URL has no user.' }),
        posts_stored: count ?? 0,
        ...(r.backfilling
          ? { backfill: `collecting older posts (about ${BACKFILL_DAYS} days) in the background; usually under a minute` }
          : {}),
        latest_posts: await present((latest ?? []) as Msg[], 600, day),
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
    const { data, error } = await step('user_channels', supabase.from('user_channels').select('username').eq('user_id', userId))
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
        ...(c.backfilling ? { collecting_older_posts: true } : {}),
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
      const { data, error } = await step('channel_stats', supabase.from('telegram_channel_stats').select('*').order('last_post', { ascending: false }))
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
        ...(c.backfilling ? { collecting_older_posts: true } : {}),
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
        'mentioned (matched by 종목명 or 종목코드). Filter by channel, by stock, and by time. Channels are polled ' +
        'every 5 minutes. Across several channels the `limit` slots are shared fairly, so one busy channel cannot ' +
        "crowd out the others; with the default window (no `since`), today's posts (KST) come first and earlier days " +
        'fill the rest. `channels` gives each channel\'s shown / today / total posts in the window: pass `channel` ' +
        'to read all of one channel. Without a channel, shows the channels the user follows ' +
        '(get_my_channels), or every collected channel if they follow none or all_channels is true. Use ' +
        'add_telegram_channel to collect a new channel.',
      inputSchema: z.object({
        channel: z.string().optional().describe("one channel (@name, name, or t.me link); omit for the user's channels"),
        all_channels: z.boolean().default(false).describe("every collected channel, not just the user's"),
        stock: z.string().optional().describe('종목코드 or exact 종목명: only posts mentioning it'),
        since: z.string().optional().describe("YYYY-MM-DD (KST) or ISO time; default: 3 days ago, today's posts first"),
        limit: z.number().int().min(1).max(100).default(20).describe('posts in all, shared fairly across channels'),
        max_chars: z.number().int().min(100).max(5000).default(1500).describe('truncate each post to this many characters'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ channel, all_channels, stock, since, limit, max_chars }) => {
      const name = channel ? channelName(channel) : null
      if (channel && !name) return json({ error: `Not a valid Telegram channel name: ${channel}` })
      // Answers from stored posts; telegram-ingest polls every channel every 5 minutes.
      // Everything that doesn't depend on another query starts now: the trading day (for names), the user's channels,
      // and the channel check.
      const day = early(latestTradingDay(supabase))
      const mineP = early(name || all_channels ? Promise.resolve([]) : myChannels())
      const existsP = name
        ? early(step('channel_exists', supabase.from('telegram_channels').select('username').eq('username', name)))
        : null

      let code: string | null = null
      if (stock) {
        code = await resolveStock(stock, day)
        if (!code) return json({ error: `Unknown stock: ${stock}. Pass a 종목코드 or the exact 종목명 (see find_stock).` })
      }

      const sinceTs = sinceIso(since, 3)
      // Round-robin across channels, today first in the default window (migration 20261118000003_telegram_feed.sql)
      const messages = (scope: string[] | null) => // null = every channel
        step('messages', supabase.rpc('telegram_feed', {
          p_since: sinceTs,
          p_limit: limit,
          p_channels: scope,
          p_stock: code,
          p_today_first: !since,
        }))

      // The backfill check runs alongside the posts query (same scope)
      let scopeLabel: string
      let res: Awaited<ReturnType<typeof messages>>
      let pending: Awaited<ReturnType<typeof stillCollecting>>
      if (name) {
        // The posts are read alongside the check; a channel that isn't collected has none, and gets the error instead
        const [exists, r, p] = await Promise.all([existsP!, messages([name]), stillCollecting([name], sinceTs)])
        if (!exists.data?.length) return json({ error: `t.me/${name} isn't collected yet. Call add_telegram_channel first.` })
        res = r
        pending = p
        scopeLabel = name
      } else {
        const mine = await mineP
        const scope = mine.length ? mine : null
        ;[res, pending] = await Promise.all([messages(scope), stillCollecting(scope, sinceTs)])
        scopeLabel = mine.length ? `your channels (${mine.length})` : 'all collected channels'
      }
      if (res.error) throw new Error(res.error.message)
      const data = (res.data ?? []) as FeedRow[]
      const channels = feedChannels(data)
      const cut = channels.filter((c) => c.shown < c.in_window)
      return json({
        scope: scopeLabel,
        count: data.length,
        ...(channels.length > 1 || cut.length ? { channels } : {}),
        ...(cut.length && !name
          ? {
            channels_note: `Slots are shared across channels${since ? '' : ", today's posts first"}; ` +
              `${cut.map((c) => c.channel).join(', ')} ${cut.length === 1 ? 'has' : 'have'} more posts in this window ` +
              'than shown. Pass channel=<name> (and a larger limit) to read one channel in full.',
          }
          : {}),
        ...withCollecting(pending),
        posts: await present(data, max_chars, day),
      })
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
      const day = early(latestTradingDay(supabase)) // for 종목명, alongside the search
      const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 5)
      const name = channel ? channelName(channel) : null
      const sinceTs = sinceIso(since, 30)
      let q = supabase.from('telegram_messages').select(MSG_COLUMNS).gte('ts', sinceTs)
      if (name) q = q.eq('username', name)
      for (const t of terms) q = q.ilike('text', `%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
      const [{ data, error }, pending] = await Promise.all([
        step('search', q.order('ts', { ascending: false }).limit(limit)),
        stillCollecting(name ? [name] : null, sinceTs),
      ])
      if (error) throw new Error(error.message)

      const snippet = (m: Msg) => {
        const i = m.text.toLowerCase().indexOf(terms[0].toLowerCase())
        const start = Math.max(0, i - 150)
        const end = Math.min(m.text.length, i + terms[0].length + 250)
        return (start > 0 ? '…' : '') + m.text.slice(start, end) + (end < m.text.length ? '…' : '')
      }
      return json({
        query: terms,
        count: data?.length ?? 0,
        ...withCollecting(pending),
        posts: await present((data ?? []) as Msg[], 0, day, snippet),
      })
    },
  )
}
