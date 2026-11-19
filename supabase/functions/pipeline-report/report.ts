// Builds the daily pipeline report (sent at 18:00 KST) from the ingest runs of the last 24 hours. Pure: index.ts
// fetches the data and sends the text.

import { GATE_PRICE } from '../_shared/gate.ts'
import { kstTime } from '../_shared/ops.ts'

export type Run = {
  job: string
  started_at: string
  ok: boolean | null // null: still running (or stopped and not yet marked; ops.ts sweepKilled marks it within minutes)
  // the function's answer: kis-ingest { date, rows, as_of } | { date, skipped }; krx-ingest { results };
  // telegram-ingest { polled, new_posts, gate?: { gated, noise, failed, left, tokens: { input, output } } | { error } }
  // deno-lint-ignore no-explicit-any
  summary: any
  error: string | null
}

export type ReportInput = {
  end: Date // the end of the window: 18:00 KST today. The window is the 24 hours before it.
  runs: Run[] // ingest_runs started in the window
  pendingKrxDays: string[] // days before today with only KIS data: KRX hasn't loaded them (YYYY-MM-DD)
  krxLatest: { bas_dd: string; row_count: number } | null // latest official day
  channelErrors: { username: string; last_error: string | null }[] // active channels currently failing
}


const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const n = (x: number) => x.toLocaleString('en-US')
const count = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`

const M = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : `${Math.round(x / 1e3)}K`)

/**
 * The Telegram gate over the window, from telegram-ingest's run summaries (telegram-ingest/gating.ts): posts gated,
 * the share labeled noise, failed calls, the backlog after the last run, tokens and their cost at Haiku's price.
 * Null when no run gated (no ANTHROPIC_API_KEY): the gate is off.
 */
export function gateReport(tg: Run[]): string | null {
  const gates = tg.map((r) => r.summary?.gate).filter((g) => g && typeof g === 'object')
  if (!gates.length) return null
  const sum = (f: (g: { gated?: number; noise?: number; failed?: number; tokens?: { input?: number; output?: number } }) => number | undefined) =>
    gates.reduce((s, g) => s + (Number(f(g)) || 0), 0)
  const gated = sum((g) => g.gated), noise = sum((g) => g.noise), failed = sum((g) => g.failed)
  const input = sum((g) => g.tokens?.input), output = sum((g) => g.tokens?.output)
  const cost = (input * GATE_PRICE.input + output * GATE_PRICE.output) / 1e6
  const broken = gates.filter((g) => typeof g.error === 'string').length
  const left = [...gates].reverse().find((g) => typeof g.left === 'number')?.left as number | undefined
  const pct = gated ? Math.round((noise / gated) * 100) : 0
  const icon = broken || (failed && failed >= gated) ? '❌' : failed ? '⚠️' : '✅'
  return `${icon} Telegram gate: ${count(gated, 'post', 'posts')} gated, ${pct}% noise (${n(noise)})` +
    `${failed ? `, ${n(failed)} failed calls` : ''}${broken ? `, ${count(broken, 'run', 'runs')} with every call failing` : ''}` +
    `${left ? `, ${n(left)} still ungated` : ''} · ${M(input)} in / ${M(output)} out tokens ≈ $${cost.toFixed(2)}`
}

/** The latest 18:00 KST (09:00 UTC) at or before `now`: the end of the report's window. */
export function reportWindowEnd(now: Date): Date {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9))
  return now < end ? new Date(end.getTime() - 86400_000) : end
}

export function buildReport({ end, runs, pendingKrxDays, krxLatest, channelErrors }: ReportInput): string {
  const kstEnd = new Date(end.getTime() + 9 * 3600_000)
  const todayIso = kstEnd.toISOString().slice(0, 10)
  const todayYmd = todayIso.replace(/-/g, '')
  const dow = kstEnd.getUTCDay()
  const weekday = dow >= 1 && dow <= 5
  const of = (job: string) => runs.filter((r) => r.job === job)

  // KIS: today's snapshots. A weekday without any, where KIS said "not a trading day", is a holiday.
  const kisToday = of('kis-ingest').filter((r) => r.summary?.date === todayYmd)
  const snapshots = kisToday.filter((r) => r.ok && typeof r.summary?.rows === 'number')
  const holiday = kisToday.some((r) => r.ok && String(r.summary?.skipped ?? '').startsWith('not a trading day'))
  const closed = !weekday || (holiday && !snapshots.length)

  const lines = [`📊 Data pipeline · ${todayIso.slice(5)} (${DOW[dow]})${closed ? ' · market closed' : ''}`]

  if (!closed) {
    if (!kisToday.length) {
      lines.push("❌ KIS: kis-ingest didn't run today")
    } else if (!snapshots.length) {
      lines.push('❌ KIS: no snapshot today')
    } else {
      const last = snapshots.reduce((a, b) => (String(b.summary.as_of) > String(a.summary.as_of) ? b : a))
      const at = kstTime(new Date(last.summary.as_of)).slice(6)
      const afterClose = at >= '15:40'
      lines.push(
        `${afterClose ? '✅' : '⚠️'} KIS: ${count(snapshots.length, 'snapshot', 'snapshots')} today, last ${at} (${n(last.summary.rows)} stocks)` +
          (afterClose ? '' : ', none after the 15:40 close'),
      )
    }
  }

  // KRX: the official data for earlier days should be in by now (published ~08:00 the next morning)
  const krxRuns = of('krx-ingest')
  if (!krxRuns.length) {
    lines.push("❌ KRX: krx-ingest didn't run (07:00–08:30)")
  } else if (pendingKrxDays.length) {
    lines.push(`❌ KRX official: ${pendingKrxDays.map((d) => d.slice(5)).join(', ')} not loaded (only KIS data)`)
  } else {
    const loaded = [...new Set(krxRuns.flatMap((r) =>
      Object.entries(r.summary?.results ?? {}).filter(([, v]) => typeof v === 'number' && v > 0).map(([d]) => d)
    ))].sort()
    lines.push(
      `✅ KRX official: latest ${krxLatest ? `${krxLatest.bas_dd.slice(5)} (${n(krxLatest.row_count)} stocks)` : '—'}` +
        (loaded.length ? `, loaded ${loaded.map((d) => `${d.slice(4, 6)}-${d.slice(6)}`).join(', ')}` : ''),
    )
  }

  // Telegram
  const tg = of('telegram-ingest')
  const polls = tg.filter((r) => !r.summary?.gate_only) // ?gate=N runs only gate (telegram-ingest/index.ts)
  if (!polls.length) {
    lines.push("❌ Telegram: telegram-ingest didn't run")
  } else {
    const posts = polls.reduce((s, r) => s + (Number(r.summary?.new_posts) || 0), 0)
    lines.push(`✅ Telegram: ${count(polls.length, 'poll', 'polls')}, ${count(posts, 'new post', 'new posts')}`)
  }
  const gateLine = gateReport(tg)
  if (gateLine) lines.push(gateLine)
  if (channelErrors.length) {
    lines.push(
      `⚠️ Telegram channels failing: ${
        channelErrors.map((c) => `${c.username}${c.last_error ? ` (${c.last_error.slice(0, 80)})` : ''}`).join(', ')
      }`,
    )
  }

  // Failed runs, per job
  const failed = runs.filter((r) => r.ok === false) // includes runs stopped at the time limit (ops.ts)
  if (!failed.length) {
    lines.push('✅ No failed runs since yesterday 18:00')
  } else {
    for (const job of [...new Set(failed.map((r) => r.job))].sort()) {
      const fs = failed.filter((r) => r.job === job)
      const last = fs[fs.length - 1]
      lines.push(
        `❌ ${job}: ${fs.length} failed run${fs.length > 1 ? 's' : ''}, last ${kstTime(new Date(last.started_at))}: ` +
          (last.error ?? 'unknown error').slice(0, 200),
      )
    }
  }
  return lines.join('\n')
}
