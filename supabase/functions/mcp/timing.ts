// Per-step timings of one tool call. The logging wrapper (index.ts) runs each tool inside timeCall(); code anywhere
// below it, including shared helpers, wraps an awaited step in step('name', promise). Outside a call (tests, other
// functions) step() just awaits. The current call is found through AsyncLocalStorage, so no timer is passed around.

import { AsyncLocalStorage } from 'node:async_hooks'

/** start = ms after the tool began, so parallel steps show as overlapping */
export type Step = { step: string; start: number; ms: number; error?: true }

type CallTimer = { t0: number; steps: Step[] }
const current = new AsyncLocalStorage<CallTimer>()

/** Runs fn as one tool call. Returns its result or error, with the steps recorded either way (in start order). */
export async function timeCall<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; result: T; steps: Step[] } | { ok: false; error: unknown; steps: Step[] }> {
  const timer: CallTimer = { t0: performance.now(), steps: [] }
  const steps = () => [...timer.steps].sort((a, b) => a.start - b.start)
  try {
    const result = await current.run(timer, fn)
    return { ok: true, result, steps: steps() }
  } catch (error) {
    return { ok: false, error, steps: steps() }
  }
}

/**
 * For work started before it's needed, so it runs alongside other queries: an early return can leave it un-awaited,
 * and this keeps its failure from becoming an unhandled rejection. Awaiting the returned promise still throws.
 */
export function early<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}

/** Awaits `work` and, inside a timed call, records how long it took. Accepts supabase-js query builders (thenables). */
export async function step<T>(name: string, work: PromiseLike<T>): Promise<T> {
  const timer = current.getStore()
  const start = performance.now()
  let failed = false
  try {
    return await work
  } catch (e) {
    failed = true
    throw e
  } finally {
    if (timer) {
      timer.steps.push({
        step: name,
        start: Math.round(start - timer.t0),
        ms: Math.round(performance.now() - start),
        ...(failed ? { error: true as const } : {}),
      })
    }
  }
}
