// YouTube channels: new uploads from each channel's RSS feed, transcripts from an Apify actor.
//
// The feed (youtube.com/feeds/videos.xml?channel_id=…) is public, needs no key, and lists a channel's newest 15
// uploads with their title, description and publish time. It answers from Supabase's regions (checked 2026-11-20 from
// ap-south-1), unlike YouTube's caption files, which refuse cloud IPs: transcripts come from Apify's
// apihq/youtube-transcript-scraper (up to 50 videos a run, one record per video, a failed video not charged).
//
// Used by youtube-ingest (scheduled polling). Tables: supabase/migrations/20261120000000_youtube.sql.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0'
import { readableError } from './errors.ts'

// A channel's first poll keeps only its newest videos; later polls keep everything newer than the oldest stored
export const BACKFILL_VIDEOS = 5
// Transcripts fetched per run (one Apify call per language), so a run stays well inside the 150 s limit
export const TRANSCRIPTS_PER_RUN = 10
// Pause before the next try of a video whose transcript isn't there yet, by attempts so far; the last one repeats
export const RETRY_MINUTES = [15, 30, 60, 120, 240, 480]
// A video still without a transcript this long after it was published is given up on ('none')
export const GIVE_UP_AFTER_MS = 48 * 3600_000
export const APIFY_ACTOR = 'apihq~youtube-transcript-scraper'
const APIFY_TIMEOUT_S = 100 // the actor's run limit; our request waits a little longer

export type FeedEntry = { video_id: string; title: string; description: string; published_at: string; short: boolean }
export type Feed = { title: string | null; entries: FeedEntry[] }

const feedUrl = (channelId: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? decodeXml(m[1]).trim() : null
}

/** The feed's Atom XML → channel title and entries, newest first as in the feed. Entries without an id or time are skipped. */
export function parseFeed(xml: string): Feed {
  const head = xml.split('<entry>')[0]
  const entries: FeedEntry[] = []
  for (const block of xml.split('<entry>').slice(1)) {
    const id = tag(block, 'yt:videoId')
    const published = tag(block, 'published')
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id) || !published || isNaN(Date.parse(published))) continue
    const link = block.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? ''
    entries.push({
      video_id: id,
      title: tag(block, 'title') ?? '',
      description: tag(block, 'media:description') ?? '',
      published_at: new Date(published).toISOString(),
      short: link.includes('/shorts/'),
    })
  }
  return { title: tag(head, 'title'), entries }
}

export async function fetchFeed(channelId: string, fetcher: typeof fetch = fetch): Promise<Feed> {
  const res = await fetcher(feedUrl(channelId), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kr-stock-mcp/1.0)' } })
  if (!res.ok) throw new Error(`feed ${channelId}: HTTP ${res.status}`)
  const xml = await res.text()
  if (!xml.includes('<feed')) throw new Error(`feed ${channelId}: not an Atom feed`)
  return parseFeed(xml)
}

/** Which feed entries to store: never Shorts; on a first poll only the newest few, later only those newer than the oldest stored. */
export function entriesToStore(entries: FeedEntry[], stored: Set<string>, oldestStored: string | null): FeedEntry[] {
  const videos = entries.filter((e) => !e.short).sort((a, b) => b.published_at.localeCompare(a.published_at))
  if (oldestStored === null) return videos.slice(0, BACKFILL_VIDEOS)
  return videos.filter((e) => !stored.has(e.video_id) && e.published_at >= oldestStored)
}

export type PollResult = { channel: string; ok: boolean; new_videos: number; error?: string }

/** Polls one channel's feed: stores its new videos (transcripts pending) and updates the channel's poll state. */
export async function pollChannel(supabase: SupabaseClient, channelId: string, fetcher: typeof fetch = fetch): Promise<PollResult> {
  try {
    const feed = await fetchFeed(channelId, fetcher)
    const ids = feed.entries.map((e) => e.video_id)
    const [{ data: have, error: e1 }, { data: oldest, error: e2 }] = await Promise.all([
      supabase.from('youtube_videos').select('video_id').in('video_id', ids.length ? ids : ['-']),
      supabase.from('youtube_videos').select('published_at').eq('channel_id', channelId).order('published_at').limit(1),
    ])
    if (e1 || e2) throw new Error((e1 ?? e2)!.message)
    const fresh = entriesToStore(feed.entries, new Set((have ?? []).map((r) => r.video_id)), oldest?.[0]?.published_at
      ? new Date(oldest[0].published_at).toISOString()
      : null)
    if (fresh.length) {
      const { error } = await supabase.from('youtube_videos').upsert(
        fresh.map(({ short: _s, ...e }) => ({ ...e, channel_id: channelId })),
        { onConflict: 'video_id', ignoreDuplicates: true },
      )
      if (error) throw new Error(`save videos: ${error.message}`)
    }
    await supabase.from('youtube_channels').update({
      ...(feed.title ? { title: feed.title } : {}),
      last_polled_at: new Date().toISOString(),
      last_error: null,
      poll_errors: 0,
    }).eq('channel_id', channelId)
    return { channel: channelId, ok: true, new_videos: fresh.length }
  } catch (e) {
    const msg = readableError((e as Error).message)
    const { data: cur } = await supabase.from('youtube_channels').select('poll_errors').eq('channel_id', channelId).single()
    await supabase.from('youtube_channels').update({
      last_polled_at: new Date().toISOString(),
      last_error: msg.slice(0, 500),
      poll_errors: (cur?.poll_errors ?? 0) + 1,
    }).eq('channel_id', channelId)
    return { channel: channelId, ok: false, new_videos: 0, error: msg }
  }
}

// ---- Transcripts ----

/** One record from the actor: a transcript, or why there isn't one. */
export type ActorRecord = {
  success: boolean
  video_id: string
  language?: string
  is_auto_generated?: boolean
  transcript?: { text: string; start: number; duration: number }[]
  metadata?: { duration_seconds?: number }
  code?: string
  error?: string
}
export type TranscriptSource = (videoIds: string[], language: string) => Promise<ActorRecord[]>

/** Calls the Apify actor synchronously: one run for up to 50 videos, its records as the answer. */
export function apifyTranscripts(token: string, fetcher: typeof fetch = fetch): TranscriptSource {
  return async (videoIds, language) => {
    const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?timeout=${APIFY_TIMEOUT_S}`
    const res = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoIds, language, metadata: true }),
      signal: AbortSignal.timeout((APIFY_TIMEOUT_S + 10) * 1000),
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`apify: HTTP ${res.status}: ${body.slice(0, 200)}`)
    const items = JSON.parse(body)
    if (!Array.isArray(items)) throw new Error('apify: unexpected answer (not a list of records)')
    return items as ActorRecord[]
  }
}

type Pending = { video_id: string; channel_id: string; published_at: string; attempts: number; language: string }
export type Outcome =
  | { status: 'ok'; transcript: string; segments: unknown[]; lang: string; auto: boolean; duration: number | null }
  | { status: 'pending' | 'none' | 'failed'; error: string; next_attempt_at?: string }

/**
 * What to do with a video given the actor's record (or none). A transcript in another language than asked for isn't
 * taken: YouTube lists auto-translated tracks too, and the channel's own one may still be on its way.
 */
export function outcomeOf(v: Pending, r: ActorRecord | undefined, now = Date.now()): Outcome {
  if (r?.success && r.transcript?.length && (r.language ?? '').split('-')[0] === v.language.split('-')[0]) {
    const text = r.transcript.map((s) => s.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')
    if (text) {
      return {
        status: 'ok',
        transcript: text,
        segments: r.transcript,
        lang: r.language!,
        auto: !!r.is_auto_generated,
        duration: r.metadata?.duration_seconds ?? null,
      }
    }
  }
  const why = !r
    ? 'no record for this video in the actor\'s answer'
    : r.success
    ? (r.transcript?.length ? `only a ${r.language} transcript, not ${v.language}` : 'empty transcript')
    : `${r.code ?? 'error'}: ${r.error ?? ''}`.trim()
  if (r?.code === 'VALIDATION_FAILED') return { status: 'failed', error: why }
  if (now - Date.parse(v.published_at) > GIVE_UP_AFTER_MS) return { status: 'none', error: why }
  const wait = RETRY_MINUTES[Math.min(v.attempts, RETRY_MINUTES.length - 1)]
  return { status: 'pending', error: why, next_attempt_at: new Date(now + wait * 60_000).toISOString() }
}

export type TranscriptSummary = { fetched: number; waiting: number; none: number; failed: number; left: number; error?: string }

/**
 * Fetches transcripts for the videos that are due (newest first, TRANSCRIPTS_PER_RUN at most), one actor call per
 * language. A call that fails as a whole (key, Apify down) leaves its videos as they were, for the next run, and is
 * reported as `error` (the run fails and alerts); one video's failure is only that video's.
 */
export async function transcriptBatch(supabase: SupabaseClient, source: TranscriptSource, limit = TRANSCRIPTS_PER_RUN): Promise<TranscriptSummary> {
  const now = new Date()
  const { data, error } = await supabase.from('youtube_videos')
    .select('video_id, channel_id, published_at, attempts, youtube_channels!inner(language)')
    .eq('transcript_status', 'pending').lte('next_attempt_at', now.toISOString())
    .order('published_at', { ascending: false }).limit(limit)
  if (error) throw new Error(`pending videos: ${error.message}`)
  const due: Pending[] = (data ?? []).map((r) => ({
    video_id: r.video_id,
    channel_id: r.channel_id,
    published_at: r.published_at,
    attempts: r.attempts,
    language: (r.youtube_channels as unknown as { language: string }).language,
  }))
  const sum: TranscriptSummary = { fetched: 0, waiting: 0, none: 0, failed: 0, left: 0 }
  const errors: string[] = []
  const byLang = new Map<string, Pending[]>()
  for (const v of due) byLang.set(v.language, [...(byLang.get(v.language) ?? []), v])
  for (const [language, videos] of byLang) {
    let records: ActorRecord[]
    try {
      records = await source(videos.map((v) => v.video_id), language)
    } catch (e) {
      errors.push(readableError((e as Error).message))
      continue
    }
    const byId = new Map(records.map((r) => [r.video_id, r]))
    for (const v of videos) {
      const o = outcomeOf(v, byId.get(v.video_id), now.getTime())
      const row = o.status === 'ok'
        ? {
          transcript: o.transcript,
          segments: o.segments,
          transcript_lang: o.lang,
          transcript_auto: o.auto,
          ...(o.duration != null ? { duration_seconds: o.duration } : {}),
          transcript_status: 'ok',
          transcribed_at: now.toISOString(),
          last_error: null,
        }
        : { transcript_status: o.status, last_error: o.error.slice(0, 500), ...(o.next_attempt_at ? { next_attempt_at: o.next_attempt_at } : {}) }
      const { error: uErr } = await supabase.from('youtube_videos').update({ ...row, attempts: v.attempts + 1 }).eq('video_id', v.video_id)
      if (uErr) throw new Error(`save transcript ${v.video_id}: ${uErr.message}`)
      if (o.status === 'ok') sum.fetched++
      else if (o.status === 'pending') sum.waiting++
      else sum[o.status]++
    }
  }
  const { count } = await supabase.from('youtube_videos').select('video_id', { count: 'exact', head: true })
    .eq('transcript_status', 'pending').lte('next_attempt_at', new Date().toISOString())
  sum.left = count ?? 0
  if (errors.length) sum.error = `transcripts: ${errors.join('; ')}`
  return sum
}
