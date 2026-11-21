// The poll loop: one channel after another, with two ways to stop early so a run ends well inside the 150 s Edge
// Function limit, with time left for the gate.
//
// - Telegram unreachable: OUTAGE_AFTER channels in a row with no answer at all (PageNetworkError) means t.me is down
//   from here, not that those channels are broken. On 2026-11-21 at 15:35 KST every page fetch timed out; each channel
//   took ~21 s (10 s timeout, 1 s pause, 10 s again) and the run was killed by the limit during the 7th channel, so it
//   never recorded what happened. Now that run stops after ~43 s.
// - The deadline: no channel starts after POLL_DEADLINE_MS (a normal run polls all channels in ~15 s).
//
// Channels not polled are left as they are (no poll error counted), and the next run starts with them, since channels
// are polled oldest last_polled_at first.

import type { SyncResult } from '../_shared/telegram.ts'

export const OUTAGE_AFTER = 2
export const POLL_DEADLINE_MS = 60_000

export type PollStop = { reason: 'unreachable' | 'deadline'; message: string }
export type PollOutcome = { results: SyncResult[]; not_polled: string[]; stopped?: PollStop }

export async function pollChannels(
  channels: string[],
  sync: (channel: string) => Promise<SyncResult>,
  opts: { deadline: number; pauseMs?: number; now?: () => number },
): Promise<PollOutcome> {
  const now = opts.now ?? Date.now
  const results: SyncResult[] = []
  let unreachableRun = 0
  let stopped: PollStop | undefined
  for (const channel of channels) {
    if (now() >= opts.deadline) {
      stopped = { reason: 'deadline', message: `poll stopped at the ${POLL_DEADLINE_MS / 1000} s deadline` }
      break
    }
    if (results.length && opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs))
    const r = await sync(channel)
    results.push(r)
    unreachableRun = r.unreachable ? unreachableRun + 1 : 0
    if (unreachableRun >= OUTAGE_AFTER) {
      stopped = {
        reason: 'unreachable',
        message: `t.me unreachable: ${unreachableRun} channels in a row gave no answer (last: ${r.error ?? 'unknown'})`,
      }
      break
    }
  }
  const polled = new Set(results.map((r) => r.channel))
  const not_polled = channels.filter((c) => !polled.has(c))
  return { results, not_polled, ...(stopped ? { stopped } : {}) }
}
