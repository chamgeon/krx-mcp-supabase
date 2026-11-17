// Which channel changes are worth an immediate Telegram alert: a channel that starts failing, or one that works
// again. A channel that stays broken (retried hourly) sends nothing more; the 18:00 report lists it. Without this, a
// permanently broken channel would alert every hour.

import type { SyncResult } from '../_shared/telegram.ts'

/** The alert text for this run's channel changes, or null when nothing changed. `errorsBefore`: poll_errors per channel. */
export function channelAlerts(errorsBefore: Map<string, number>, results: SyncResult[]): string | null {
  const lines: string[] = []
  for (const r of results) {
    const wasFailing = (errorsBefore.get(r.channel) ?? 0) > 0
    if (!r.ok && !wasFailing) lines.push(`❌ Telegram channel ${r.channel} started failing: ${(r.error ?? 'unknown error').slice(0, 200)}`)
    if (r.ok && wasFailing) lines.push(`✅ Telegram channel ${r.channel} works again`)
  }
  return lines.length ? lines.join('\n') : null
}
