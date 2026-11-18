// Runs calls a few at a time under a calls-per-second cap. kis-ingest makes ~93 KIS calls per run; one after another,
// the run's time is 93 × KIS's response time, which went from ~0.16 s to ~1.1 s per call on 2026-11-18 and pushed
// runs past the 150 s limit. With several in flight it's bounded by the cap instead (93 calls at 10/s ≈ 9 s).

export type PoolOptions = {
  concurrency: number // calls in flight at once
  perSecond: number // call starts per second, at most (evenly spaced)
}

/**
 * fn over every item, at most `concurrency` at a time and `perSecond` starts per second. Results are in item order.
 * The first failure rejects the whole run; calls already in flight finish, and no new ones start.
 */
export async function pacedPool<T, R>(items: T[], opts: PoolOptions, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  const gap = 1000 / opts.perSecond
  let next = 0 // index of the next item to start
  let nextStart = performance.now() // earliest time the next call may start
  let failed = false

  async function worker() {
    while (!failed && next < items.length) {
      const i = next++
      const now = performance.now()
      const wait = nextStart - now
      nextStart = Math.max(now, nextStart) + gap
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      if (failed) return
      try {
        results[i] = await fn(items[i], i)
      } catch (e) {
        failed = true
        throw e
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, items.length) }, worker))
  return results
}
