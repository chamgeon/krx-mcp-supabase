// Polls every active public Telegram channel in public.telegram_channels and stores new posts in
// public.telegram_messages (see ../_shared/telegram.ts for how a channel is read).
//
// Called by pg_cron (see sql/cron.example.sql). Protected by the x-ingest-secret header.
//
//   POST /functions/v1/telegram-ingest                 -> poll all active channels (newest page; more if there's a gap)
//   POST /functions/v1/telegram-ingest?channel=ehdwl   -> poll one channel
//   POST /functions/v1/telegram-ingest?gate=500        -> no polling: gate up to 500 ungated posts now (e.g. the posts
//                                                         stored before the gate, at once instead of 40 per run)
//   POST /functions/v1/telegram-ingest?page=stockbot[&before=9139]
//                                                      -> relay: one preview page as fetched from this region,
//                                                         {status, html}. mcp runs in Mumbai, where Telegram hides
//                                                         some previews, and fetches its pages through this in Seoul
//                                                         (../_shared/telegram.ts, relayPages). Not an ingest run: not
//                                                         recorded in ingest_runs.
//
// The cron sends x-region: ap-northeast-2, so runs (and the relay) fetch from Seoul (log 2026-11-20).
//
// Channels that keep failing (e.g. the owner turned the preview off) are retried at most hourly. Returns 500 when any
// channel fails, so failures show up in the function logs.
//
// After polling, it resumes backfills that stalled: a new channel's older posts are fetched in the background by the
// MCP function, and if that worker ended midway (no progress for 3 minutes), the backfill continues here from its
// saved progress. A failed backfill page doesn't fail the run (the channel's own poll reports a broken channel); it
// counts towards the page cap, so retries end.
//
// Then the gate (./gating.ts, ../_shared/gate.ts): the newest ungated posts, GATE_BATCH per run, are labeled market or
// noise and tagged by Claude Haiku (KR codes, US tickers, events), and us_symbols is refreshed daily. It runs only when
// ANTHROPIC_API_KEY is set. A post whose call fails stays ungated for the next run; if every call fails (key, outage),
// the run fails and alerts.

import 'jsr:@supabase/functions-js@2.119.0/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import {
  backfillChannel, type BackfillResult, BACKFILL_STALE_MS, channelName, directPage, syncChannel, type SyncResult,
} from '../_shared/telegram.ts'
import { monitored, sendTelegram } from '../_shared/ops.ts'
import Anthropic from 'npm:@anthropic-ai/sdk@1.5.0'
import { channelAlerts } from './alerts.ts'
import { GATE_MAX, gateBatch, type GateSummary, refreshUsSymbols } from './gating.ts'

const INGEST_SECRET = Deno.env.get('INGEST_SECRET')!
const HERE_REGION = Deno.env.get('SB_REGION') || null // set by Supabase; unset locally
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

const CHANNEL_PAUSE_MS = 300
const FAILING_RETRY_MS = 3600_000

// Every run is recorded in ingest_runs (../_shared/ops.ts). Channel failures alert only when a channel starts failing or
// works again (./alerts.ts); a failure of the whole run (no per-channel results), or of the whole gate step, gets the
// usual hourly alert.
const wholeRunFailed = (body: unknown) => {
  const b = body as { results?: unknown; gate?: { error?: string } } | null
  return !Array.isArray(b?.results) || typeof b?.gate?.error === 'string'
}

const ingest = monitored('telegram-ingest', supabase, async (req) => {
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }

  const params = new URL(req.url).searchParams
  if (params.has('gate')) {
    if (!anthropic) return Response.json({ error: 'ANTHROPIC_API_KEY is not set' }, { status: 400 })
    const n = Math.min(Math.max(1, Number(params.get('gate')) || GATE_MAX), GATE_MAX)
    const symbols = await refreshUsSymbols(supabase).catch((e) => ({ error: (e as Error).message }))
    const gate = await gateBatch(supabase, anthropic, n)
    return Response.json({ gate_only: true, results: [], gate, us_symbols: symbols }, { status: gate.error ? 500 : 200 })
  }

  const only = params.get('channel')?.toLowerCase()
  let q = supabase.from('telegram_channels').select('username, poll_errors, last_polled_at').eq('active', true)
  if (only) q = q.eq('username', only)
  const { data: channels, error } = await q.order('last_polled_at', { ascending: true, nullsFirst: true })
  if (error) return Response.json({ error: error.message }, { status: 500 })

  const now = Date.now()
  const due = (channels ?? []).filter((c) =>
    only || c.poll_errors < 3 || !c.last_polled_at || now - new Date(c.last_polled_at).getTime() > FAILING_RETRY_MS
  )

  const results: SyncResult[] = []
  for (const c of due) {
    if (results.length) await new Promise((r) => setTimeout(r, CHANNEL_PAUSE_MS))
    results.push(await syncChannel(supabase, c.username))
  }

  const alert = channelAlerts(new Map(due.map((c) => [c.username, c.poll_errors])), results)
  if (alert) await sendTelegram(alert)

  // Stalled backfills, for channels whose poll works (a failing channel's backfill would fail the same way)
  const stale = new Date(Date.now() - BACKFILL_STALE_MS).toISOString()
  let bq = supabase.from('telegram_channels').select('username')
    .eq('active', true).eq('poll_errors', 0).not('backfill_before', 'is', null).lt('backfill_at', stale)
  if (only) bq = bq.eq('username', only)
  const { data: stalled, error: bErr } = await bq
  if (bErr) return Response.json({ error: bErr.message, results }, { status: 500 })
  const backfills: BackfillResult[] = []
  for (const c of stalled ?? []) {
    await new Promise((r) => setTimeout(r, CHANNEL_PAUSE_MS))
    backfills.push(await backfillChannel(supabase, c.username, { resume: true }))
  }

  // The gate, after the posts are stored. Its own errors don't stop the run; a gate that failed entirely fails it.
  let gate: GateSummary | { error: string } | null = null
  let symbols: unknown = null
  if (anthropic && !only) {
    try {
      symbols = await refreshUsSymbols(supabase)
    } catch (e) {
      symbols = { error: (e as Error).message } // the stored list stays in use
    }
    try {
      gate = await gateBatch(supabase, anthropic)
    } catch (e) {
      gate = { error: `gate: ${(e as Error).message}` }
    }
  }

  const failed = results.filter((r) => !r.ok)
  return Response.json(
    {
      ran_in: HERE_REGION,
      polled: results.length,
      skipped: (channels?.length ?? 0) - due.length,
      new_posts: results.reduce((n, r) => n + r.new_posts, 0),
      results,
      ...(backfills.length ? { backfills } : {}),
      ...(gate ? { gate } : {}),
      ...(symbols && (symbols as { refreshed?: boolean }).refreshed !== false ? { us_symbols: symbols } : {}),
    },
    { status: failed.length || (gate && 'error' in gate && gate.error) ? 500 : 200 },
  )
}, { alertOn: wholeRunFailed })

// The page relay (see the top). Only a valid channel name and a numeric `before`: it fetches t.me previews, nothing else.
async function relayPage(params: URLSearchParams): Promise<Response> {
  const raw = params.get('page') ?? ''
  const channel = channelName(raw)
  const before = params.get('before')
  if (!channel || channel !== raw.toLowerCase() || (before !== null && !/^\d{1,12}$/.test(before))) {
    return Response.json({ error: 'page: a channel name, and before as a number' }, { status: 400 })
  }
  return Response.json(await directPage(channel, before ? Number(before) : undefined))
}

Deno.serve((req) => {
  const params = new URL(req.url).searchParams
  if (!params.has('page')) return ingest(req)
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) return new Response('unauthorized', { status: 401 })
  return relayPage(params).catch((e) => Response.json({ error: (e as Error).message }, { status: 502 }))
})
