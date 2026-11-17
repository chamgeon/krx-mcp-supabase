// Operations: a record of every ingest run (public.ingest_runs) and Telegram messages to the operator.
//
// Each ingest function wraps its handler in monitored(): the run is recorded with its outcome, and a failed run sends
// an immediate Telegram alert, at most one per job per hour, so a broken key doesn't send one every 5 minutes. The
// daily report (pipeline-report) reads the same table.
//
// Secrets (supabase secrets set ...): TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID (the operator's chat
// with the bot). Without them nothing is sent; the message is logged instead.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

const ALERT_EVERY_MS = 3600_000

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
    // telegram-ingest: { results: [{ channel, ok, error }] }
    for (const r of b.results as { channel?: string; ok?: boolean; error?: string }[]) {
      if (r?.ok === false) out.push(`${r.channel ?? '?'}: ${r.error ?? 'failed'}`)
    }
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

type Handler = (req: Request) => Promise<Response>

/**
 * Wraps an ingest function's handler: records the run in ingest_runs and alerts on failure. A 401 (a request without
 * the ingest secret) isn't a run and isn't recorded. Recording never changes the answer, and a recording failure is
 * only logged.
 */
export function monitored(job: string, supabase: SupabaseClient, handler: Handler): Handler {
  return async (req) => {
    const startedAt = new Date()
    const t0 = performance.now()
    let res: Response
    try {
      res = await handler(req)
    } catch (e) {
      res = Response.json({ error: (e as Error).message }, { status: 500 })
    }
    if (res.status === 401) return res
    try {
      await record(supabase, job, startedAt, Math.round(performance.now() - t0), res)
    } catch (e) {
      console.error('ingest_runs: could not record the run:', (e as Error).message)
    }
    return res
  }
}

async function record(supabase: SupabaseClient, job: string, startedAt: Date, ms: number, res: Response) {
  const body = await res.clone().json().catch(() => null)
  const error = res.ok ? null : (errorOf(body) ?? `HTTP ${res.status}`)
  let alerted = false
  if (!res.ok) {
    const { data } = await supabase.from('ingest_runs').select('id').eq('job', job).eq('alerted', true)
      .gte('started_at', new Date(Date.now() - ALERT_EVERY_MS).toISOString()).limit(1)
    if (!data?.length) {
      alerted = await sendTelegram(
        `❌ ${job} failed (${kstTime(startedAt)} KST, HTTP ${res.status})\n${error!.slice(0, 600)}\n\n` +
          'Further failures of this job within an hour are recorded without another alert.',
      )
    }
  }
  const { error: insertError } = await supabase.from('ingest_runs').insert({
    job,
    started_at: startedAt.toISOString(),
    ms,
    ok: res.ok,
    status: res.status,
    summary: summaryOf(body),
    error: error?.slice(0, 1000) ?? null,
    alerted,
  })
  if (insertError) throw new Error(insertError.message)
}
