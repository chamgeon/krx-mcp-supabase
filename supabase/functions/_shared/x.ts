// X (Twitter) accounts: posts through an Apify actor, xquik/x-tweet-scraper (X's own API is pay-per-use, ~$0.005 a
// post read; the actor is ~$0.15 per 1,000 posts plus ~$0.00008 a run, checked 2026-11-20 on Apify's free plan).
//
// A new account's latest BACKFILL_POSTS posts are fetched once; after that one actor run for all accounts asks for
// posts since the oldest account's last poll (minus a small overlap: posts are upserted by id, so overlap only
// refreshes their counts). Retweets are left out in the actor, so they aren't paid for; posts, quotes and the
// author's own replies are kept.
//
// Used by x-ingest (scheduled polling) and the MCP tools (add an account). Tables: migrations/20261120000002_x.sql.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0'
import { readableError } from './errors.ts'

export const X_ACTOR = 'xquik~x-tweet-scraper'
export const BACKFILL_POSTS = 20
const POLL_PER_ACCOUNT = 50 // more than any account posts in 5 minutes; a cap, not a target
const POLL_OVERLAP_MS = 10 * 60_000
const ACTOR_TIMEOUT_S = 100

/** "@CharlieBilello", "x.com/charliebilello", "https://twitter.com/charliebilello/status/1" → "charliebilello"; null if not a handle. */
export function accountName(input: string): string | null {
  const s = input.trim().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/^(www\.|mobile\.)?(x|twitter)\.com\//, '').replace(/^@/, '')
  const name = s.split(/[/?#]/)[0]
  return /^[A-Za-z0-9_]{1,15}$/.test(name) ? name.toLowerCase() : null
}

/** One record from the actor (the fields used here). */
export type XItem = {
  id?: string
  type?: string
  text?: string
  url?: string
  lang?: string
  createdAt?: string
  isRetweet?: boolean
  isReply?: boolean
  noteTweet?: { text?: string } | null
  viewCount?: number | null
  likeCount?: number | null
  retweetCount?: number | null
  replyCount?: number | null
  quoted_tweet?: { id?: string; text?: string } | null
  quotedTweetPermalink?: string | null
  media?: { type?: string; mediaUrl?: string }[] | null
  entities?: { urls?: { expanded_url?: string; expandedUrl?: string }[] } | null
  author?: {
    id?: string
    username?: string
    name?: string
    description?: string | null
    followers?: number | null
    verified?: boolean
    isBlueVerified?: boolean
    isVerified?: boolean
  } | null
}

export type XPostRow = {
  id: string
  username: string
  ts: string
  text: string
  url: string
  lang: string | null
  is_reply: boolean
  quoted_text: string | null
  quoted_url: string | null
  media: string[]
  links: string[]
  views: number | null
  likes: number | null
  reposts: number | null
  replies: number | null
}

/** A record → a row, or null for what isn't kept: retweets, other authors' posts, records without an id or time. */
export function toRow(it: XItem): XPostRow | null {
  const username = it.author?.username?.toLowerCase()
  const ts = it.createdAt ? new Date(it.createdAt) : null
  if (!it.id || !/^\d{1,20}$/.test(it.id) || !username || !ts || isNaN(ts.getTime())) return null
  if (it.isRetweet || it.type === 'retweet') return null
  // Long posts (X Premium) carry their full text in noteTweet; t.co links to the post's own media are noise
  const text = (it.noteTweet?.text || it.text || '').replace(/\s*https:\/\/t\.co\/\w+\s*$/, '').trim()
  return {
    id: it.id,
    username,
    ts: ts.toISOString(),
    text,
    url: it.url || `https://x.com/${username}/status/${it.id}`,
    lang: it.lang ?? null,
    is_reply: !!it.isReply,
    quoted_text: it.quoted_tweet?.text?.trim() || null,
    quoted_url: it.quotedTweetPermalink || null,
    media: (it.media ?? []).flatMap((m) => (m.mediaUrl ? [m.mediaUrl] : [])),
    links: [...new Set((it.entities?.urls ?? []).flatMap((u) => {
      const href = u.expanded_url ?? u.expandedUrl
      return href && /^https?:/.test(href) ? [href] : []
    }))],
    views: it.viewCount ?? null,
    likes: it.likeCount ?? null,
    reposts: it.retweetCount ?? null,
    replies: it.replyCount ?? null,
  }
}

export type XRequest = { handles: string[]; perAccount: number; sinceTime?: Date }
export type PostSource = (req: XRequest) => Promise<XItem[]>

/** Calls the actor synchronously: one run for all the handles, its records as the answer. */
export function xquikPosts(token: string, fetcher: typeof fetch = fetch): PostSource {
  return async ({ handles, perAccount, sinceTime }) => {
    const input = {
      twitterHandles: handles,
      maxItemsPerTarget: perAccount,
      maxItems: perAccount * handles.length,
      queryType: 'Latest',
      tweetTypes: { excludeRetweets: true },
      ...(sinceTime ? { time: { sinceTime: String(Math.floor(sinceTime.getTime() / 1000)) } } : {}),
    }
    const res = await fetcher(`https://api.apify.com/v2/acts/${X_ACTOR}/run-sync-get-dataset-items?timeout=${ACTOR_TIMEOUT_S}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout((ACTOR_TIMEOUT_S + 10) * 1000),
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`apify: HTTP ${res.status}: ${body.slice(0, 200)}`)
    const items = JSON.parse(body)
    if (!Array.isArray(items)) throw new Error('apify: unexpected answer (not a list of records)')
    return items as XItem[]
  }
}

async function savePosts(supabase: SupabaseClient, all: XPostRow[]) {
  const rows = [...new Map(all.map((r) => [r.id, r])).values()] // one row per id (an upsert can't take one twice)
  if (!rows.length) return
  // Posts seen again refresh their counts (views grow for days); the text can change too (an edit)
  const { error } = await supabase.from('x_posts').upsert(rows.map((r) => ({ ...r, fetched_at: new Date().toISOString() })), { onConflict: 'id' })
  if (error) throw new Error(`save posts: ${error.message}`)
}

export type BackfillResult = { account: string; ok: boolean; posts: number; error?: string }

/**
 * An account's latest posts, once, when it's added. An account with none (missing, protected, or reposts only)
 * comes back with posts: 0; whether that's an error is the caller's call (add_x_account refuses it).
 */
export async function backfillAccount(supabase: SupabaseClient, source: PostSource, username: string): Promise<BackfillResult> {
  const startedAt = new Date().toISOString()
  try {
    const items = await source({ handles: [username], perAccount: BACKFILL_POSTS })
    const rows = items.map(toRow).filter((r): r is XPostRow => !!r && r.username === username)
    await savePosts(supabase, rows)
    await saveAuthors(supabase, items)
    await supabase.from('x_accounts').update({
      last_polled_at: startedAt,
      last_error: rows.length ? null : 'no posts found (the account may not exist, be protected, or only repost)',
      poll_errors: 0,
    }).eq('username', username)
    return { account: username, ok: true, posts: rows.length }
  } catch (e) {
    const msg = readableError((e as Error).message)
    await markFailed(supabase, [username], msg)
    return { account: username, ok: false, posts: 0, error: msg }
  }
}

// last_polled_at is the point the next poll asks from, so a failure leaves it alone (moving it would skip the posts
// in between); only the error is recorded
async function markFailed(supabase: SupabaseClient, usernames: string[], msg: string) {
  const { data } = await supabase.from('x_accounts').select('username, poll_errors').in('username', usernames)
  for (const a of data ?? []) {
    await supabase.from('x_accounts').update({ last_error: msg.slice(0, 500), poll_errors: a.poll_errors + 1 }).eq('username', a.username)
  }
}

/** The account fields a post's author carries; only those present, so a record without a bio doesn't erase it. */
export function authorProfile(a: NonNullable<XItem['author']>) {
  const desc = a.description?.trim()
  return {
    ...(a.id ? { x_user_id: a.id } : {}),
    ...(a.name ? { name: a.name } : {}),
    ...(desc !== undefined ? { description: desc || null } : {}),
    ...(typeof a.followers === 'number' ? { followers: a.followers } : {}),
    ...(a.verified !== undefined || a.isVerified !== undefined || a.isBlueVerified !== undefined
      ? { verified: !!(a.verified || a.isVerified || a.isBlueVerified) }
      : {}),
  }
}

/** Saves each account's id, name, bio, followers and verified flag from its newest post in the answer. */
async function saveAuthors(supabase: SupabaseClient, items: XItem[]) {
  const seen = new Map<string, ReturnType<typeof authorProfile>>()
  for (const it of items) {
    const u = it.author?.username?.toLowerCase()
    if (u && !seen.has(u)) seen.set(u, authorProfile(it.author!))
  }
  for (const [username, a] of seen) {
    if (Object.keys(a).length) await supabase.from('x_accounts').update(a).eq('username', username)
  }
}

export type PollSummary = { accounts: number; new_posts: number; backfilled: BackfillResult[]; error?: string }

/**
 * One poll: accounts never polled get their backfill; the rest share one actor run asking for posts since the
 * oldest of their last polls (minus an overlap). A failed run leaves their poll times as they were (the next run
 * asks from the same point) and is reported as `error`.
 */
export async function pollAccounts(supabase: SupabaseClient, source: PostSource): Promise<PollSummary> {
  const { data, error } = await supabase.from('x_accounts').select('username, last_polled_at').eq('active', true)
  if (error) throw new Error(`accounts: ${error.message}`)
  const fresh = (data ?? []).filter((a) => !a.last_polled_at).map((a) => a.username)
  const polled = (data ?? []).filter((a) => a.last_polled_at)
  const sum: PollSummary = { accounts: data?.length ?? 0, new_posts: 0, backfilled: [] }

  for (const u of fresh) {
    const r = await backfillAccount(supabase, source, u)
    sum.backfilled.push(r)
    sum.new_posts += r.posts
  }
  if (!polled.length) return sum

  const startedAt = new Date()
  const oldest = Math.min(...polled.map((a) => Date.parse(a.last_polled_at!)))
  const handles = polled.map((a) => a.username)
  let items: XItem[]
  try {
    items = await source({ handles, perAccount: POLL_PER_ACCOUNT, sinceTime: new Date(oldest - POLL_OVERLAP_MS) })
  } catch (e) {
    const msg = readableError((e as Error).message)
    await markFailed(supabase, handles, msg)
    sum.error = `x: ${msg}`
    return sum
  }
  const rows = items.map(toRow).filter((r): r is XPostRow => !!r && handles.includes(r.username))
  const { data: known } = await supabase.from('x_posts').select('id').in('id', rows.length ? rows.map((r) => r.id) : ['0'])
  const knownIds = new Set((known ?? []).map((r) => r.id))
  await savePosts(supabase, rows)
  await saveAuthors(supabase, items)
  sum.new_posts += rows.filter((r) => !knownIds.has(r.id)).length
  const { error: uErr } = await supabase.from('x_accounts')
    .update({ last_polled_at: startedAt.toISOString(), last_error: null, poll_errors: 0 }).in('username', handles)
  if (uErr) throw new Error(`save poll state: ${uErr.message}`)
  return sum
}
