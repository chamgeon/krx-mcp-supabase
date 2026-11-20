// MCP tools for YouTube channels: add a channel, follow channels, list videos, read a transcript in parts.
// Collection lives in ../_shared/youtube.ts; scheduled polling and transcripts in ../youtube-ingest.

import type { McpServer } from 'npm:@modelcontextprotocol/server@2.4.0'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0'
import { z } from 'npm:zod@4.6.7'
import { clock, fetchFeed, pollChannel, resolveChannel, type Segment, transcriptMatches, transcriptPart } from '../_shared/youtube.ts'
import { step } from './timing.ts'

// Cap on collected channels: every new video costs a transcript (~$0.003), so adding channels can't run up the bill
const MAX_YT_CHANNELS = 20
// Default and largest part of a transcript per call. ~6,000 Korean characters is a few thousand tokens and ~18 KB
// (3 bytes a character), inside SIZE-1's 20 KB p95; the largest, ~45 KB, stays under SIZE-2's 64 KB. A model reads
// further parts with from_seconds.
const PART_CHARS = 6000
const PART_CHARS_MAX = 15000
// list_youtube_videos stops adding videos past this many bytes of JSON (SIZE-2), and says so
const LIST_BYTES = 48_000
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] }
}
function kst(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') + ' KST'
}
const videoLink = (id: string, at = 0) => `https://www.youtube.com/watch?v=${id}${at >= 1 ? `&t=${Math.floor(at)}s` : ''}`
const channelLink = (id: string) => `https://www.youtube.com/channel/${id}`

const LOGIN_REQUIRED = {
  error: 'Channel preferences are not available on this connection, because it has no user account. ' +
    'list_youtube_videos shows every collected channel instead; pass channel=<id or @handle> to list one.',
}
const TRANSCRIPT_NOTE: Record<string, string> = {
  pending: 'The transcript is not available yet (YouTube adds captions a while after upload; a live stream has none ' +
    'until it ends). It is retried automatically; ask again later.',
  none: 'This video has no transcript (no captions within 48 hours of publishing).',
  failed: 'The transcript could not be fetched for this video.',
}

type VideoRow = {
  video_id: string
  channel_id: string
  title: string
  description: string
  published_at: string
  duration_seconds: number | null
  transcript_status: string
  transcript_auto: boolean | null
  transcript_chars?: number | null
}

export function registerYoutubeTools(server: McpServer, supabase: SupabaseClient, userId: string | null) {
  // A collected channel from an id, @handle, link or its exact title; else, for an id/@handle/link, the channel id
  // it names (not collected yet). Error message when it's none of these.
  async function findChannel(input: string): Promise<{ id: string; collected: boolean } | { error: string }> {
    const s = input.trim()
    const { data: byTitle } = await step('yt_channel_title', supabase.from('youtube_channels').select('channel_id').eq('title', s).limit(1))
    if (byTitle?.length) return { id: byTitle[0].channel_id, collected: true }
    let id: string | null
    try {
      id = await step('yt_resolve', resolveChannel(s))
    } catch (e) {
      return { error: `could not look up ${s}: ${(e as Error).message}` }
    }
    if (!id) return { error: `not a YouTube channel: ${s} (pass an @handle, a channel link, or a UC… channel id)` }
    const { data } = await step('yt_channel', supabase.from('youtube_channels').select('channel_id').eq('channel_id', id))
    return { id, collected: !!data?.length }
  }

  // Makes sure a channel is collected: a new one is checked (its feed), saved and polled now (its newest 5 videos;
  // transcripts follow within minutes, from youtube-ingest).
  async function ensureChannel(input: string): Promise<{ ok: true; id: string; status: string; new_videos?: number } | { ok: false; error: string }> {
    const f = await findChannel(input)
    if ('error' in f) return { ok: false, error: f.error }
    if (f.collected) {
      await step('yt_reactivate', supabase.from('youtube_channels').update({ active: true }).eq('channel_id', f.id).eq('active', false))
      return { ok: true, id: f.id, status: 'already collected' }
    }
    const { count } = await step('yt_channel_count', supabase.from('youtube_channels').select('*', { count: 'exact', head: true }).eq('active', true))
    if ((count ?? 0) >= MAX_YT_CHANNELS) {
      return { ok: false, error: `the collection limit (${MAX_YT_CHANNELS} YouTube channels) is reached; ask the operator to raise it` }
    }
    let title: string | null
    try {
      title = (await step('yt_feed', fetchFeed(f.id))).title
    } catch (e) {
      return { ok: false, error: `no public feed for ${f.id}: ${(e as Error).message}` }
    }
    const { error } = await step('yt_channel_insert', supabase.from('youtube_channels').insert({ channel_id: f.id, title, added_by: userId }))
    if (error) throw new Error(error.message)
    const poll = await step('yt_poll', pollChannel(supabase, f.id))
    if (!poll.ok) return { ok: false, error: poll.error ?? 'poll failed' }
    return { ok: true, id: f.id, status: 'added', new_videos: poll.new_videos }
  }

  async function follow(ids: string[]): Promise<boolean> {
    if (!userId || !ids.length) return false
    const { error } = await supabase.from('user_youtube_channels')
      .upsert(ids.map((channel_id) => ({ user_id: userId, channel_id })), { onConflict: 'user_id,channel_id', ignoreDuplicates: true })
    if (error) throw new Error(error.message)
    return true
  }

  async function myChannelIds(): Promise<string[]> {
    if (!userId) return []
    const { data, error } = await step('user_youtube_channels', supabase.from('user_youtube_channels').select('channel_id').eq('user_id', userId))
    if (error) throw new Error(error.message)
    return (data ?? []).map((r) => r.channel_id)
  }

  // Collected channels (all, or these ids) with their video counts: videos with a transcript, and still waiting
  async function channelRows(ids: string[] | null, withPollState: boolean) {
    let cq = supabase.from('youtube_channels').select('channel_id, title, active, last_polled_at, last_error').order('title')
    let vq = supabase.from('youtube_videos').select('channel_id, published_at, transcript_status')
    if (ids) {
      cq = cq.in('channel_id', ids)
      vq = vq.in('channel_id', ids)
    }
    const [{ data: chans, error }, { data: vids, error: e2 }] = await Promise.all([step('yt_channels', cq), step('yt_video_counts', vq)])
    if (error || e2) throw new Error((error ?? e2)!.message)
    const stats = new Map<string, { transcripts: number; waiting: number; last: string | null }>()
    for (const v of vids ?? []) {
      const s = stats.get(v.channel_id) ?? { transcripts: 0, waiting: 0, last: null }
      if (v.transcript_status === 'ok') {
        s.transcripts++
        if (!s.last || v.published_at > s.last) s.last = v.published_at
      } else if (v.transcript_status === 'pending') s.waiting++
      stats.set(v.channel_id, s)
    }
    return (chans ?? []).map((c) => {
      const s = stats.get(c.channel_id)
      return {
        channel: c.title,
        channel_id: c.channel_id,
        link: channelLink(c.channel_id),
        videos_with_transcript: s?.transcripts ?? 0,
        ...(s?.waiting ? { waiting_for_transcript: s.waiting } : {}),
        last_video: s?.last ? kst(s.last) : null,
        ...(withPollState ? { active: c.active, last_polled: c.last_polled_at ? kst(c.last_polled_at) : null } : c.active ? {} : { active: false }),
        ...(c.last_error ? { error: c.last_error } : {}),
      }
    })
  }

  async function myChannelsView() {
    const mine = await myChannelIds()
    if (!mine.length) return { channels: [], note: 'You follow no YouTube channels yet; list_youtube_videos shows all of them.' }
    return { channels: await channelRows(mine, false) }
  }

  server.registerTool(
    'add_youtube_channel',
    {
      title: '유튜브 채널 추가',
      description:
        'Starts collecting a YouTube channel for everyone on this deployment (its newest 5 videos now, then every new ' +
        'upload) and follows it for the current user. Transcripts (Korean by default) arrive within about 10 minutes ' +
        'of a video being stored, once YouTube has captions for it. Accepts an @handle, a channel link, or a UC… id.',
      inputSchema: z.object({ channel: z.string().min(1).describe('@handle, https://www.youtube.com/@handle, or a UC… channel id') }),
    },
    async ({ channel }) => {
      const r = await ensureChannel(channel)
      if (!r.ok) return json({ channel, error: r.error })
      const followed = await step('yt_follow', follow([r.id]))
      const { data: ch } = await step('yt_channel_row', supabase.from('youtube_channels').select('title').eq('channel_id', r.id).single())
      const { data: vids } = await step('yt_latest', supabase.from('youtube_videos')
        .select('video_id, title, published_at, transcript_status').eq('channel_id', r.id).order('published_at', { ascending: false }).limit(5))
      return json({
        channel: ch?.title ?? null,
        channel_id: r.id,
        status: r.status,
        ...(followed ? { followed_by_you: true } : { note: 'Collected for everyone on this deployment. Following is not available on this connection.' }),
        ...(r.status === 'added' ? { transcripts: 'fetched in the background within about 10 minutes' } : {}),
        latest_videos: (vids ?? []).map((v) => ({
          video_id: v.video_id, title: v.title, published: kst(v.published_at), transcript: v.transcript_status, link: videoLink(v.video_id),
        })),
      })
    },
  )

  server.registerTool(
    'get_my_youtube_channels',
    {
      title: '내 유튜브 채널',
      description:
        'The YouTube channels the current user follows (their default for list_youtube_videos), with how many videos ' +
        'have a transcript and the latest one. All collected channels: list_youtube_channels.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => (userId ? json(await myChannelsView()) : json(LOGIN_REQUIRED)),
  )

  server.registerTool(
    'list_youtube_channels',
    {
      title: '수집 중인 유튜브 채널',
      description:
        'YouTube channels being collected on this deployment, with how many videos have a transcript, how many are ' +
        'still waiting for one, the latest video, and poll status.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => json(await channelRows(null, true)),
  )

  server.registerTool(
    'update_my_youtube_channels',
    {
      title: '내 유튜브 채널 추가/삭제',
      description:
        "Adds and/or removes YouTube channels from the current user's followed list (channel titles of collected " +
        'channels work too). A channel not collected yet is added first. Removing only unfollows; collection continues.',
      inputSchema: z.object({
        add: z.array(z.string()).max(20).optional().describe('channels to follow: @handle, link, UC… id, or a collected channel\'s title'),
        remove: z.array(z.string()).max(20).optional().describe('channels to unfollow'),
      }),
    },
    async ({ add, remove }) => {
      if (!userId) return json(LOGIN_REQUIRED)
      const ok: string[] = []
      const failed: { channel: string; error: string }[] = []
      for (const input of add ?? []) {
        const r = await ensureChannel(input)
        if (r.ok) ok.push(r.id)
        else failed.push({ channel: input, error: r.error })
      }
      await follow(ok)
      const drop: string[] = []
      for (const input of remove ?? []) {
        const f = await findChannel(input)
        if ('error' in f) failed.push({ channel: input, error: f.error })
        else drop.push(f.id)
      }
      if (drop.length) {
        const { error } = await supabase.from('user_youtube_channels').delete().eq('user_id', userId).in('channel_id', drop)
        if (error) throw new Error(error.message)
      }
      return json({
        ...(await myChannelsView()),
        ...(ok.length ? { followed: ok } : {}),
        ...(drop.length ? { unfollowed: drop } : {}),
        ...(failed.length ? { not_changed: failed } : {}),
      })
    },
  )

  server.registerTool(
    'list_youtube_videos',
    {
      title: '유튜브 영상 목록',
      description:
        "Recent videos with a transcript from the user's followed YouTube channels (all collected channels if they " +
        'follow none), newest first: title, time, length and the start of the description. Videos still waiting for ' +
        'their transcript are only counted. With query, only videos whose title, description or transcript mention ' +
        'it, with the matching excerpts and their times. Read a transcript with get_youtube_transcript.',
      inputSchema: z.object({
        channel: z.string().optional().describe('one channel: @handle, UC… id, or a collected channel\'s title'),
        query: z.string().min(1).optional().describe('a word or phrase to look for (Korean spacing is ignored in transcripts)'),
        days: z.number().int().min(1).max(60).optional().describe('how far back, in days (default 7)'),
        limit: z.number().int().min(1).max(30).optional().describe('videos to return (default 10)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ channel, query, days, limit }) => {
      let scope: string[] | null = null
      if (channel) {
        const f = await findChannel(channel)
        if ('error' in f) return json({ error: f.error })
        if (!f.collected) return json({ error: `${channel} is not collected yet (add it with add_youtube_channel)` })
        scope = [f.id]
      } else {
        const mine = await myChannelIds()
        if (mine.length) scope = mine
      }
      const since = new Date(Date.now() - (days ?? 7) * 86400_000).toISOString()
      const n = limit ?? 10
      let q = supabase.from('youtube_videos')
        .select('video_id, channel_id, title, description, published_at, duration_seconds, transcript_status, transcript_auto' + (query ? ', segments' : ''))
        .eq('transcript_status', 'ok').gte('published_at', since).order('published_at', { ascending: false })
      if (scope) q = q.in('channel_id', scope)
      let waitingQ = supabase.from('youtube_videos').select('video_id', { count: 'exact', head: true })
        .eq('transcript_status', 'pending').gte('published_at', since)
      if (scope) waitingQ = waitingQ.in('channel_id', scope)
      if (query) {
        // Letters, digits and spaces only (the filter syntax uses , ( ) and the regex its own characters). In the
        // transcript, spaces between the characters are optional, as in transcriptMatches.
        const words = query.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().replace(/\s+/g, ' ')
        if (!words) return json({ error: 'query: give a word or phrase' })
        const spaced = [...words.replace(/\s/g, '')].join('\\s*')
        q = q.or(`title.ilike.%${words}%,description.ilike.%${words}%,transcript.imatch.${spaced}`).limit(n * 2)
      } else {
        q = q.limit(n)
      }
      const [{ data, error }, { data: chans }, { count: waiting }] = await Promise.all([
        step('yt_videos', q),
        step('yt_channel_titles', supabase.from('youtube_channels').select('channel_id, title')),
        step('yt_waiting', waitingQ),
      ])
      if (error) throw new Error(error.message)
      const titles = new Map((chans ?? []).map((c) => [c.channel_id, c.title]))
      const rows = (data ?? []) as unknown as (VideoRow & { segments?: Segment[] | null })[]
      const videos = rows.map((v) => {
        const matches = query && v.segments ? transcriptMatches(v.segments, query, 3, 120) : []
        const inText = query ? `${v.title}\n${v.description}`.toLowerCase().includes(query.trim().toLowerCase()) : true
        return {
          keep: !query || inText || matches.length > 0,
          out: {
            video_id: v.video_id,
            channel: titles.get(v.channel_id) ?? v.channel_id,
            title: v.title,
            published: kst(v.published_at),
            ...(v.duration_seconds ? { length: clock(v.duration_seconds) } : {}),
            ...(v.description ? { description: v.description.slice(0, 300) + (v.description.length > 300 ? '…' : '') } : {}),
            ...(matches.length
              ? { matches: matches.map((m) => ({ time: m.time, excerpt: m.excerpt, link: videoLink(v.video_id, m.at) })) }
              : {}),
            link: videoLink(v.video_id),
          },
        }
      }).filter((x) => x.keep).slice(0, n).map((x) => x.out)
      const shown: typeof videos = []
      let size = 0
      for (const v of videos) {
        size += bytes(v)
        if (shown.length && size > LIST_BYTES) break
        shown.push(v)
      }
      return json({
        scope: scope ? (channel ? 'one channel' : 'channels you follow') : 'all collected channels',
        since: kst(since),
        videos: shown,
        ...(waiting ? { waiting_for_transcript: `${waiting} video${waiting === 1 ? ' in this period is' : 's in this period are'} still waiting for a transcript (fetched within minutes of YouTube adding captions; a live stream has none until it ends)` } : {}),
        ...(shown.length < videos.length
          ? { truncated: `${videos.length - shown.length} more videos left out to keep the answer small; narrow with channel, days or limit` }
          : {}),
      })
    },
  )

  server.registerTool(
    'get_youtube_transcript',
    {
      title: '유튜브 자막',
      description:
        'The transcript of a collected YouTube video, one part at a time (about 6,000 characters, with a [m:ss] ' +
        'marker each minute). A long video comes in several parts: the answer gives next_from_seconds; call again ' +
        'with from_seconds set to it for the next part. With query, returns only the excerpts around a word or ' +
        'phrase, with their times, instead of the text. Auto-generated captions can misspell names (e.g. 엔트로픽 for ' +
        'Anthropic).',
      inputSchema: z.object({
        video: z.string().min(1).describe('video id (11 characters) or a youtube.com / youtu.be link'),
        from_seconds: z.number().min(0).optional().describe('where to start, in seconds (default 0; use next_from_seconds)'),
        max_chars: z.number().int().min(1000).max(PART_CHARS_MAX).optional().describe(`part size (default ${PART_CHARS})`),
        query: z.string().min(1).optional().describe('return only the passages that mention this'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ video, from_seconds, max_chars, query }) => {
      const id = video.trim().match(/(?:v=|youtu\.be\/|shorts\/|live\/|^)([A-Za-z0-9_-]{11})(?:$|[&?#/])/)?.[1]
      if (!id) return json({ error: `not a video id or link: ${video}` })
      const { data, error } = await step('yt_video', supabase.from('youtube_videos')
        .select('video_id, channel_id, title, published_at, duration_seconds, transcript_status, transcript_auto, transcript_lang, segments, youtube_channels(title)')
        .eq('video_id', id).maybeSingle())
      if (error) throw new Error(error.message)
      if (!data) return json({ error: `video ${id} is not collected (only videos of collected channels have transcripts; see list_youtube_videos)` })
      const head = {
        video_id: id,
        channel: (data.youtube_channels as unknown as { title: string | null } | null)?.title ?? data.channel_id,
        title: data.title,
        published: kst(data.published_at),
        ...(data.duration_seconds ? { length: clock(data.duration_seconds) } : {}),
        link: videoLink(id),
      }
      if (data.transcript_status !== 'ok' || !data.segments) {
        return json({ ...head, transcript: data.transcript_status, note: TRANSCRIPT_NOTE[data.transcript_status] ?? '' })
      }
      const segs = data.segments as Segment[]
      const auto = data.transcript_auto ? { auto_generated: true } : {}
      if (query) {
        const matches = transcriptMatches(segs, query)
        return json({
          ...head, ...auto, query,
          matches: matches.map((m) => ({ time: m.time, excerpt: m.excerpt, link: videoLink(id, m.at) })),
          ...(matches.length ? {} : { note: `"${query}" does not come up in the transcript.` }),
        })
      }
      const part = transcriptPart(segs, from_seconds ?? 0, max_chars ?? PART_CHARS)
      if (part.from === null) return json({ ...head, ...auto, error: `nothing after ${clock(from_seconds ?? 0)}: the transcript ends earlier` })
      const total = segs.reduce((n, s) => n + s.text.length + 1, 0)
      return json({
        ...head, ...auto,
        language: data.transcript_lang,
        part: `${clock(part.from)}–${clock(part.to!)}`,
        total_chars: total,
        ...(part.next_from !== null
          ? { next_from_seconds: Math.floor(part.next_from * 100) / 100, more: 'Call again with from_seconds = next_from_seconds for the next part.' }
          : { end: true }),
        text: part.text,
      })
    },
  )
}
