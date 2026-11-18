// Run from the repo root: deno task test

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1.0.19'
import { pacedPool } from './pool.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

Deno.test('pacedPool: results in item order, never more than `concurrency` in flight', async () => {
  let inFlight = 0
  let peak = 0
  const out = await pacedPool([1, 2, 3, 4, 5, 6, 7, 8], { concurrency: 3, perSecond: 1000 }, async (x) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await sleep(x % 2 ? 30 : 5) // uneven durations, so calls finish out of order
    inFlight--
    return x * 10
  })
  assertEquals(out, [10, 20, 30, 40, 50, 60, 70, 80])
  assertEquals(peak, 3)
})

Deno.test('pacedPool: starts are spaced by the per-second cap', async () => {
  const starts: number[] = []
  await pacedPool([1, 2, 3, 4, 5], { concurrency: 5, perSecond: 20 }, (x) => {
    starts.push(performance.now())
    return Promise.resolve(x)
  })
  const gaps = starts.slice(1).map((t, i) => t - starts[i])
  assert(gaps.every((g) => g >= 45), `gaps under 50 ms: ${gaps.map(Math.round)}`) // 20/s = 50 ms (timer slack)
})

Deno.test('pacedPool: speeds up slow calls, bounded by concurrency', async () => {
  const t0 = performance.now()
  await pacedPool(Array.from({ length: 10 }, (_, i) => i), { concurrency: 5, perSecond: 1000 }, () => sleep(50))
  const ms = performance.now() - t0
  assert(ms >= 95 && ms < 250, `10 calls of 50 ms, 5 at a time: ${Math.round(ms)} ms`) // ~100 ms, not ~500
})

Deno.test('pacedPool: the first failure rejects, and no new calls start', async () => {
  const started: number[] = []
  await assertRejects(
    () =>
      pacedPool([0, 1, 2, 3, 4, 5, 6, 7], { concurrency: 2, perSecond: 1000 }, async (x) => {
        started.push(x)
        await sleep(10)
        if (x === 1) throw new Error('KIS FHKST11300006: HTTP 500')
        return x
      }),
    Error,
    'HTTP 500',
  )
  await sleep(50)
  assert(started.length <= 3, `started after the failure: ${started}`) // 0 and 1, plus at most one already waiting
})

Deno.test('pacedPool: no items', async () => {
  assertEquals(await pacedPool([], { concurrency: 5, perSecond: 10 }, () => Promise.resolve(1)), [])
})
