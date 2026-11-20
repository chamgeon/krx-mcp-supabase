// Polls every active YouTube channel in public.youtube_channels for new uploads (its RSS feed) and fetches the
// transcripts of videos still waiting for one (an Apify actor); see ../_shared/youtube.ts.
//
// Called by pg_cron every 5 minutes (sql/cron.example.sql). Protected by the x-ingest-secret header.
//
//   POST /functions/v1/youtube-ingest                      -> poll all active channels, then fetch due transcripts
//   POST /functions/v1/youtube-ingest?channel=UC…          -> poll one channel (transcripts too)
//
// A channel's first poll stores its newest 5 videos (the backfill); later polls, every newer one. Transcripts run only
// when APIFY_API_KEY is set: up to 10 videos a run, newest first. A video whose transcript isn't there yet (captions
// take a while; a live stream has none until it ends) is retried after 15 min, 30 min, 1 h … 8 h, and given up on 48 h
// after it was published. A channel that keeps failing is retried at most hourly. Returns 500 when a channel fails or
// the transcript call fails as a whole, so ingest_runs records it and the operator is alerted (hourly at most).

import 'jsr:@supabase/functions-js@2.119.0/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { monitored } from '../_shared/ops.ts'
import { apifyTranscripts, pollChannel, type PollResult, transcriptBatch, type TranscriptSummary } from '../_shared/youtube.ts'

const INGEST_SECRET = Deno.env.get('INGEST_SECRET')!
const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')
const HERE_REGION = Deno.env.get('SB_REGION') || null // set by Supabase; unset locally
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

const FAILING_RETRY_MS = 3600_000

Deno.serve(monitored('youtube-ingest', supabase, async (req) => {
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }
  const only = new URL(req.url).searchParams.get('channel')
  let q = supabase.from('youtube_channels').select('channel_id, poll_errors, last_polled_at').eq('active', true)
  if (only) q = q.eq('channel_id', only)
  const { data: channels, error } = await q.order('last_polled_at', { ascending: true, nullsFirst: true })
  if (error) return Response.json({ error: error.message }, { status: 500 })

  // A failing channel (e.g. deleted) is retried at most hourly, unless asked for by name
  const due = (channels ?? []).filter((c) =>
    only || c.poll_errors === 0 || !c.last_polled_at || Date.now() - Date.parse(c.last_polled_at) > FAILING_RETRY_MS
  )
  const results: PollResult[] = []
  for (const c of due) results.push(await pollChannel(supabase, c.channel_id))

  let transcripts: TranscriptSummary | { error: string } | null = null
  if (APIFY_API_KEY) {
    try {
      transcripts = await transcriptBatch(supabase, apifyTranscripts(APIFY_API_KEY))
    } catch (e) {
      transcripts = { error: `transcripts: ${(e as Error).message}` }
    }
  }

  const failed = results.filter((r) => !r.ok)
  return Response.json(
    {
      ran_in: HERE_REGION,
      polled: results.length,
      skipped: (channels?.length ?? 0) - due.length,
      new_videos: results.reduce((n, r) => n + r.new_videos, 0),
      results,
      transcripts,
    },
    { status: failed.length || (transcripts && 'error' in transcripts && transcripts.error) ? 500 : 200 },
  )
}))
