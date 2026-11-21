// Operations: a record of every ingest run (public.ingest_runs) and Telegram messages to the operator.
//
// Each ingest function wraps its handler in monitored(): the run is recorded with its outcome, and a failed run sends
// an immediate Telegram alert, at most one per job per hour, so a broken key doesn't send one every 5 minutes. The
// daily report (pipeline-report) reads the same table.
//
// A run that hits the Edge Function time limit (150 s on the free plan) is stopped mid-way and never gets to record
// itself, so the row is written when the run starts (ok = null: running) and completed at the end. A row still
// running KILLED_AFTER_MS after it started was stopped: the next monitored run of any job (telegram-ingest runs every
// 5 minutes) marks it failed and alerts. A handler can save its progress into the running row (run.progress), so a
// stopped run shows how far it got.
//
// Secrets (supabase secrets set ...): TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID (the operator's chat
// with the bot). Without them nothing is sent; the message is logged instead.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0'
import { readableError } from './errors.ts'

const ALERT_EVERY_MS = 3600_000
// The free plan's Edge Function wall-clock limit is 150 s (pg_net's timeout in sql/cron.example.sql is the same); a
// row still running after this was stopped
export const KILLED_AFTER_MS = 180_000
export const KILLED_ERROR =
  'stopped before it finished: no answer within the 150 s Edge Function limit, so the run never recorded its outcome'

/** Sends a plain-text message to the operator. Returns false (and logs why) when it couldn't. */
export async function sendTelegram(text: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  const chat = Deno.env.get('TELEGRAM_CHAT_ID')
  if (!token || !chat) {
    console.warn('telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set, so not sent:\n' + text)
    return false
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    })
    if (res.ok) return true
    console.error('telegram: sendMessage failed:', res.status, (await res.text()).slice(0, 200))
  } catch (e) {
    console.error('telegram: sendMessage failed:', (e as Error).message)
  }
  return false
}

/** Why a run failed, from the function's JSON answer (each ingest function reports errors its own way). */
export function errorOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.error === 'string') return b.error // kis-ingest: { error }
  const out: string[] = []
  if (Array.isArray(b.results)) {
    // telegram-ingest: a poll that stopped early (Telegram unreachable, the deadline) first: { poll_stopped }
    if (typeof b.poll_stopped === 'string') out.push(b.poll_stopped)
    // and its per-channel results: { results: [{ channel, ok, error }] }
    for (const r of b.results as { channel?: string; ok?: boolean; error?: string }[]) {
      if (r?.ok === false) out.push(`${r.channel ?? '?'}: ${r.error ?? 'failed'}`)
    }
    // and its gate step, when every call failed: { gate: { error } }
    const gate = b.gate as { error?: unknown } | undefined
    if (typeof gate?.error === 'string') out.push(gate.error)
    // youtube-ingest: same per-channel results, and its transcript step: { transcripts: { error } }
    const transcripts = b.transcripts as { error?: unknown } | undefined
    if (typeof transcripts?.error === 'string') out.push(transcripts.error)
  } else if (b.results && typeof b.results === 'object') {
    // krx-ingest: { results: { "20261117": 2789 | "error: …" } }
    for (const [day, r] of Object.entries(b.results)) {
      if (typeof r === 'string') out.push(`${day}: ${r.replace(/^error: /, '')}`)
    }
  }
  return out.length ? out.join('; ') : null
}

/** The answer as stored: Telegram's per-channel results are cut to the failed channels. */
export function summaryOf(body: unknown): unknown {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { results?: unknown }).results)) return body ?? null
  const b = body as { results: { ok?: boolean }[] }
  return { ...b, results: b.results.filter((r) => r?.ok === false) }
}

/** "11-17 09:05" in KST */
export function kstTime(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')
}

/** Given to a monitored handler. progress(): merges fields into the running row's summary ({ progress: … }). */
export type RunContext = { progress(fields: Record<string, unknown>): Promise<void> }
type Handler = (req: Request) => Promise<Response>
type MonitoredHandler = (req: Request, run: RunContext) => Promise<Response>
type MonitorOptions = {
  // Whether a failed run sends the hourly-throttled alert (default: always). telegram-ingest alerts about channel
  // changes itself and uses this only for failures of the whole run.
  alertOn?: (body: unknown) => boolean
}

/**
 * Wraps an ingest function's handler: records the run in ingest_runs (a running row at the start, completed at the
 * end) and alerts on failure; first it marks runs that were stopped before finishing (sweepKilled). A 401 (a request
 * without the ingest secret) isn't a run, and its row is removed. Recording never changes the answer, and a recording
 * failure is only logged; if the running row couldn't be written, the outcome is inserted at the end instead.
 */
export function monitored(
  job: string,
  supabase: SupabaseClient,
  handler: MonitoredHandler,
  opts: MonitorOptions = {},
): Handler {
  return async (req) => {
    const startedAt = new Date()
    const t0 = performance.now()
    const [id] = await Promise.all([
      startRun(supabase, job, startedAt),
      sweepKilled(supabase).catch((e) => console.error('ingest_runs: sweep failed:', (e as Error).message)),
    ])
    const saved: Record<string, unknown> = {}
    const run: RunContext = {
      async progress(fields) {
        Object.assign(saved, fields)
        if (id == null) return
        const { error } = await supabase.from('ingest_runs').update({ summary: { progress: saved } }).eq('id', id)
        if (error) console.error('ingest_runs: could not save progress:', error.message)
      },
    }
    let res: Response
    try {
      res = await handler(req, run)
    } catch (e) {
      res = Response.json({ error: (e as Error).message }, { status: 500 })
    }
    if (res.status === 401) {
      if (id != null) await supabase.from('ingest_runs').delete().eq('id', id)
      return res
    }
    try {
      await record(supabase, job, id, startedAt, Math.round(performance.now() - t0), res, opts)
    } catch (e) {
      console.error('ingest_runs: could not record the run:', (e as Error).message)
    }
    return res
  }
}

/** The running row (ok = null), or null if it couldn't be written. */
async function startRun(supabase: SupabaseClient, job: string, startedAt: Date): Promise<number | null> {
  const { data, error } = await supabase.from('ingest_runs')
    .insert({ job, started_at: startedAt.toISOString(), ok: null }).select('id').single()
  if (error) {
    console.error('ingest_runs: could not record the start:', error.message)
    return null
  }
  return data.id
}

/** Whether `job` sent a failure alert within the last hour (the hourly throttle). */
async function alertedRecently(supabase: SupabaseClient, job: string): Promise<boolean> {
  const { data } = await supabase.from('ingest_runs').select('id').eq('job', job).eq('alerted', true)
    .gte('started_at', new Date(Date.now() - ALERT_EVERY_MS).toISOString()).limit(1)
  return !!data?.length
}

/**
 * Marks runs still running KILLED_AFTER_MS after they started as failed (they were stopped at the time limit), and
 * alerts for each, within the per-job hourly throttle. The update only takes rows still running, so when two
 * functions sweep at once each stopped run is marked, and alerted, once. Returns how many it marked.
 */
export async function sweepKilled(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - KILLED_AFTER_MS).toISOString()
  const { data, error } = await supabase.from('ingest_runs')
    .update({ ok: false, error: KILLED_ERROR })
    .is('ok', null).lt('started_at', cutoff)
    .select('id, job, started_at, summary')
  if (error) throw new Error(error.message)
  for (const r of data ?? []) {
    if (await alertedRecently(supabase, r.job)) continue
    const progress = r.summary?.progress
    const sent = await sendTelegram(
      `❌ ${r.job} was stopped before it finished (started ${kstTime(new Date(r.started_at))} KST): no answer within ` +
        'the 150 s Edge Function limit.' +
        (progress ? `\nLast progress: ${JSON.stringify(progress).slice(0, 500)}` : '') +
        '\n\nFurther failures of this job within an hour are recorded without another alert.',
    )
    if (sent) await supabase.from('ingest_runs').update({ alerted: true }).eq('id', r.id)
  }
  return data?.length ?? 0
}

async function record(
  supabase: SupabaseClient,
  job: string,
  id: number | null,
  startedAt: Date,
  ms: number,
  res: Response,
  opts: MonitorOptions,
) {
  const body = await res.clone().json().catch(() => null)
  const error = res.ok ? null : readableError(errorOf(body) ?? `HTTP ${res.status}`)
  let alerted = false
  if (!res.ok && (opts.alertOn?.(body) ?? true) && !(await alertedRecently(supabase, job))) {
    alerted = await sendTelegram(
      `❌ ${job} failed (${kstTime(startedAt)} KST, HTTP ${res.status})\n${error!.slice(0, 600)}\n\n` +
        'Further failures of this job within an hour are recorded without another alert.',
    )
  }
  const outcome = {
    ms,
    ok: res.ok,
    status: res.status,
    summary: summaryOf(body),
    error: error?.slice(0, 1000) ?? null,
    alerted,
  }
  const { error: saveError } = id != null
    ? await supabase.from('ingest_runs').update(outcome).eq('id', id)
    : await supabase.from('ingest_runs').insert({ job, started_at: startedAt.toISOString(), ...outcome })
  if (saveError) throw new Error(saveError.message)
}
