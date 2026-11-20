// MCP tools for X (Twitter) accounts: add an account, follow accounts, read their posts.
// Collection lives in ../_shared/x.ts; scheduled polling in ../x-ingest.

import type { McpServer } from 'npm:@modelcontextprotocol/server@2.4.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0'
import { z } from 'npm:zod@4.6.7'
import { accountName, backfillAccount, xquikPosts } from '../_shared/x.ts'
import { step } from './timing.ts'

// Cap on collected accounts: all share one actor run per poll, so the cost is in their posts (~$0.15 per 1,000);
// the cap keeps adding accounts from running up the bill
const MAX_X_ACCOUNTS = 20
// get_x_feed's answer, as sent, stays under this (SIZE-2: no response > 64 KB); posts that don't fit are left out
// and the answer says how many. ~90 English posts fit (Bilello's average ~530 bytes), ~40–50 Korean ones.
export const FEED_MAX_BYTES = 64_000

const answerText = (data: unknown) => JSON.stringify(data, null, 1)
function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: answerText(data) }] }
}
const byteLength = (s: string) => new TextEncoder().encode(s).length

/** The answer with as many of the posts as fit in maxBytes (at least one), and a note on how many were left out. */
export function fitPosts<T>(make: (posts: T[], leftOut: number) => unknown, posts: T[], maxBytes = FEED_MAX_BYTES): unknown {
  let n = posts.length
  let answer = make(posts, 0)
  while (n > 1 && byteLength(answerText(answer)) > maxBytes) {
    // jump close to the size that fits, then step down one at a time
    const over = byteLength(answerText(answer)) / maxBytes
    n = Math.max(1, Math.min(n - 1, Math.floor(n / over)))
    answer = make(posts.slice(0, n), posts.length - n)
  }
  // the jump can undershoot: take back posts while they still fit
  while (n < posts.length) {
    const more = make(posts.slice(0, n + 1), posts.length - n - 1)
    if (byteLength(answerText(more)) > maxBytes) break
    answer = more
    n++
  }
  return answer
}
function kst(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') + ' KST'
}

const LOGIN_REQUIRED = {
  error: 'Account preferences are not available on this connection, because it has no user account. ' +
    'get_x_feed shows every collected account instead; pass account=<handle> to read one.',
}

type PostRow = {
  id: string
  username: string
  ts: string
  text: string
  url: string
  is_reply: boolean
  quoted_text: string | null
  quoted_url: string | null
  media: string[]
  links: string[]
  views: number | null
  likes: number | null
  reposts: number | null
}
const POST_COLUMNS = 'id, username, ts, text, url, is_reply, quoted_text, quoted_url, media, links, views, likes, reposts'

function present(p: PostRow) {
  return {
    account: `@${p.username}`,
    time: kst(p.ts),
    text: p.text,
    ...(p.is_reply ? { reply: true } : {}),
    ...(p.quoted_text ? { quoting: { text: p.quoted_text.slice(0, 500), ...(p.quoted_url ? { link: p.quoted_url } : {}) } } : {}),
    ...(p.media.length ? { images: p.media } : {}),
    ...(p.links.length ? { links: p.links.slice(0, 5) } : {}),
    ...(p.views != null ? { views: p.views } : {}),
    ...(p.likes != null ? { likes: p.likes } : {}),
    link: p.url,
  }
}

export function registerXTools(server: McpServer, supabase: SupabaseClient, userId: string | null) {
  async function follow(names: string[]): Promise<boolean> {
    if (!userId || !names.length) return false
    const { error } = await supabase.from('user_x_accounts')
      .upsert(names.map((username) => ({ user_id: userId, username })), { onConflict: 'user_id,username', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
    return true
  }

  async function myAccounts(): Promise<string[]> {
    if (!userId) return []
    const { data, error } = await step('user_x_accounts', supabase.from('user_x_accounts').select('username').eq('user_id', userId))
    if (error) throw new Error(error.message)
    return (data ?? []).map((r) => r.username)
  }

  // Makes sure an account is collected: a new one is saved and its latest posts fetched now (a few seconds); one
  // with no posts is refused (missing, protected, or reposts only) and not kept.
  async function ensureAccount(input: string): Promise<{ ok: true; name: string; status: string; posts?: number } | { ok: false; error: string }> {
    const name = accountName(input)
    if (!name) return { ok: false, error: `not an X handle: ${input}` }
    const { data: existing } = await step('x_account', supabase.from('x_accounts').select('username, active').eq('username', name))
    if (existing?.length) {
      if (!existing[0].active) await step('x_reactivate', supabase.from('x_accounts').update({ active: true, poll_errors: 0 }).eq('username', name))
      return { ok: true, name, status: existing[0].active ? 'already collected' : 'reactivated' }
    }
    const key = Deno.env.get('APIFY_API_KEY')
    if (!key) return { ok: false, error: 'X collection is not set up on this deployment (no APIFY_API_KEY)' }
    const { count } = await step('x_account_count', supabase.from('x_accounts').select('*', { count: 'exact', head: true }).eq('active', true))
    if ((count ?? 0) >= MAX_X_ACCOUNTS) {
      return { ok: false, error: `the collection limit (${MAX_X_ACCOUNTS} X accounts) is reached; ask the operator to raise it` }
    }
    const { error } = await step('x_account_insert', supabase.from('x_accounts').insert({ username: name, added_by: userId }))
    if (error) throw new Error(error.message)
    const r = await step('x_backfill', backfillAccount(supabase, xquikPosts(key), name))
    if (!r.ok || r.posts === 0) {
      await supabase.from('x_accounts').delete().eq('username', name)
      return { ok: false, error: r.ok ? `@${name} has no public posts (it may not exist, be protected, or only repost)` : `@${name}: ${r.error}` }
    }
    return { ok: true, name, status: 'added', posts: r.posts }
  }

  // Accounts (all, or these) with post counts and the latest post
  async function accountRows(names: string[] | null, withPollState: boolean) {
    let aq = supabase.from('x_accounts').select('username, name, description, followers, verified, active, last_polled_at, last_error').order('username')
    if (names) aq = aq.in('username', names)
    const { data: accounts, error } = await step('x_accounts', aq)
    if (error) throw new Error(error.message)
    const rows = []
    for (const a of accounts ?? []) {
      const [{ count }, { data: last }] = await Promise.all([
        supabase.from('x_posts').select('id', { count: 'exact', head: true }).eq('username', a.username),
        supabase.from('x_posts').select('ts').eq('username', a.username).order('ts', { ascending: false }).limit(1),
      ])
      rows.push({
        account: `@${a.username}`,
        name: a.name,
        ...(a.description ? { bio: a.description } : {}),
        ...(a.followers != null ? { followers: a.followers } : {}),
        ...(a.verified ? { verified: true } : {}),
        link: `https://x.com/${a.username}`,
        posts: count ?? 0,
        last_post: last?.[0]?.ts ? kst(last[0].ts) : null,
        ...(withPollState ? { active: a.active, last_polled: a.last_polled_at ? kst(a.last_polled_at) : null } : a.active ? {} : { active: false }),
        ...(a.last_error ? { error: a.last_error } : {}),
      })
    }
    return rows
  }

  async function myAccountsView() {
    const mine = await myAccounts()
    if (!mine.length) return { accounts: [], note: 'You follow no X accounts yet; get_x_feed shows all of them.' }
    return { accounts: await accountRows(mine, false) }
  }

  server.registerTool(
    'add_x_account',
    {
      title: 'X 계정 추가',
      description:
        'Starts collecting an X (Twitter) account for everyone on this deployment and follows it for the current ' +
        'user: its latest 20 posts now (takes a few seconds), then new ones every 5 minutes. Reposts are left out. ' +
        'Accepts @handle, handle, or an x.com / twitter.com link.',
      inputSchema: z.object({ account: z.string().min(1).describe('@handle, handle, or https://x.com/handle') }),
    },
    async ({ account }) => {
      const r = await ensureAccount(account)
      if (!r.ok) return json({ account, error: r.error })
      const followed = await step('x_follow', follow([r.name]))
      const [{ data: a }, { data: latest }] = await Promise.all([
        step('x_account_row', supabase.from('x_accounts').select('name, description, followers, verified').eq('username', r.name).single()),
        step('x_latest', supabase.from('x_posts').select(POST_COLUMNS).eq('username', r.name).order('ts', { ascending: false }).limit(5)),
      ])
      return json({
        account: `@${r.name}`,
        name: a?.name ?? null,
        ...(a?.description ? { bio: a.description } : {}),
        ...(a?.followers != null ? { followers: a.followers } : {}),
        ...(a?.verified ? { verified: true } : {}),
        link: `https://x.com/${r.name}`,
        status: r.status,
        ...(r.posts != null ? { posts_collected: r.posts } : {}),
        ...(followed ? { followed_by_you: true } : { note: 'Collected for everyone on this deployment. Following is not available on this connection.' }),
        latest_posts: ((latest ?? []) as PostRow[]).map(present),
      })
    },
  )

  server.registerTool(
    'get_my_x_accounts',
    {
      title: '내 X 계정',
      description:
        'The X accounts the current user follows (their default for get_x_feed): name, bio, followers, profile link, ' +
        'post counts and the latest post. All collected accounts: list_x_accounts.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => (userId ? json(await myAccountsView()) : json(LOGIN_REQUIRED)),
  )

  server.registerTool(
    'update_my_x_accounts',
    {
      title: '내 X 계정 추가/삭제',
      description:
        "Adds and/or removes X accounts from the current user's followed list. An account not collected yet is added " +
        'first (its latest posts are fetched, a few seconds each). Removing only unfollows; collection continues.',
      inputSchema: z.object({
        add: z.array(z.string()).max(20).optional().describe('accounts to follow (@handle or x.com links)'),
        remove: z.array(z.string()).max(20).optional().describe('accounts to unfollow'),
      }),
    },
    async ({ add, remove }) => {
      if (!userId) return json(LOGIN_REQUIRED)
      const ok: string[] = []
      const failed: { account: string; error: string }[] = []
      for (const input of add ?? []) {
        const r = await ensureAccount(input)
        if (r.ok) ok.push(r.name)
        else failed.push({ account: input, error: r.error })
      }
      await follow(ok)
      const drop = (remove ?? []).map(accountName).filter((n): n is string => !!n)
      if (drop.length) {
        const { error } = await supabase.from('user_x_accounts').delete().eq('user_id', userId).in('username', drop)
        if (error) throw new Error(error.message)
      }
      return json({
        ...(await myAccountsView()),
        ...(ok.length ? { followed: ok.map((n) => `@${n}`) } : {}),
        ...(drop.length ? { unfollowed: drop.map((n) => `@${n}`) } : {}),
        ...(failed.length ? { not_added: failed } : {}),
      })
    },
  )

  server.registerTool(
    'list_x_accounts',
    {
      title: '수집 중인 X 계정',
      description:
        'X accounts being collected on this deployment: name, bio, followers, verified, profile link, post counts, the ' +
        'latest post, and poll status.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => json(await accountRows(null, true)),
  )

  server.registerTool(
    'get_x_feed',
    {
      title: 'X 게시물',
      description:
        "Recent posts from the user's followed X accounts (all collected accounts if they follow none), newest first: " +
        'text, time, the post it quotes, image links (often charts), view and like counts, and a link. With query, ' +
        'only posts containing all its words. Reposts are not collected.',
      inputSchema: z.object({
        account: z.string().optional().describe('one account: @handle'),
        query: z.string().min(1).optional().describe('words every returned post contains (case-insensitive)'),
        days: z.number().int().min(1).max(30).optional().describe('how far back, in days (default 3)'),
        limit: z.number().int().min(1).max(100).optional().describe('posts to return (default 30)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ account, query, days, limit }) => {
      let scope: string[] | null = null
      if (account) {
        const name = accountName(account)
        if (!name) return json({ error: `not an X handle: ${account}` })
        const { data } = await step('x_account', supabase.from('x_accounts').select('username').eq('username', name))
        if (!data?.length) return json({ error: `@${name} is not collected yet (add it with add_x_account)` })
        scope = [name]
      } else {
        const mine = await myAccounts()
        if (mine.length) scope = mine
      }
      const since = new Date(Date.now() - (days ?? 3) * 86400_000).toISOString()
      let q = supabase.from('x_posts').select(POST_COLUMNS).gte('ts', since).order('ts', { ascending: false }).limit(limit ?? 30)
      if (scope) q = q.in('username', scope)
      for (const w of (query ?? '').replace(/[%_\\]/g, ' ').split(/\s+/).filter(Boolean)) q = q.ilike('text', `%${w}%`)
      const { data, error } = await step('x_feed', q)
      if (error) throw new Error(error.message)
      const posts = ((data ?? []) as PostRow[]).map(present)
      return json(fitPosts((shown, leftOut) => ({
        scope: scope ? (account ? 'one account' : 'accounts you follow') : 'all collected accounts',
        since: kst(since),
        count: shown.length,
        posts: shown,
        ...(leftOut
          ? { truncated: `${leftOut} older posts left out to keep the answer under 64 KB; narrow with account, days or query, or ask for an earlier window` }
          : {}),
      }), posts))
    },
  )
}
