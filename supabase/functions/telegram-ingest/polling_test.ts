// Unit tests for the poll loop's early stops. No network, no database: sync is a stub.
// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1.0.19'
import type { SyncResult } from '../_shared/telegram.ts'
import { OUTAGE_AFTER, pollChannels } from './polling.ts'

const ok = (channel: string): SyncResult => ({ channel, ok: true, new_posts: 0, pages: 1 })
const down = (channel: string): SyncResult => ({ channel, ok: false, new_posts: 0, pages: 1, error: 'no answer in 10 s', unreachable: true })
const broken = (channel: string): SyncResult => ({ channel, ok: false, new_posts: 0, pages: 1, error: 'no posts parsed' })
const ALL = ['a', 'b', 'c', 'd', 'e']

Deno.test('pollChannels: polls every channel when nothing goes wrong', async () => {
  const out = await pollChannels(ALL, async (c) => ok(c), { deadline: Infinity })
  assertEquals([out.results.length, out.not_polled, out.stopped], [5, [], undefined])
})

Deno.test('pollChannels: stops after OUTAGE_AFTER unreachable channels in a row; the rest are not polled', async () => {
  const asked: string[] = []
  const out = await pollChannels(ALL, async (c) => (asked.push(c), down(c)), { deadline: Infinity })
  assertEquals(asked, ALL.slice(0, OUTAGE_AFTER))
  assertEquals(out.not_polled, ALL.slice(OUTAGE_AFTER))
  assertEquals(out.stopped?.reason, 'unreachable')
})

Deno.test('pollChannels: one unreachable channel, or a broken one, does not stop the loop', async () => {
  const plan: Record<string, (c: string) => SyncResult> = { a: down, b: ok, c: down, d: broken, e: down }
  const out = await pollChannels(ALL, async (c) => plan[c](c), { deadline: Infinity })
  assertEquals([out.results.length, out.stopped], [5, undefined])
})

Deno.test('pollChannels: no channel starts after the deadline', async () => {
  let t = 0
  const out = await pollChannels(ALL, async (c) => (t += 25_000, ok(c)), { deadline: 60_000, now: () => t })
  assertEquals(out.results.map((r) => r.channel), ['a', 'b', 'c']) // started at 0, 25 and 50 s
  assertEquals(out.not_polled, ['d', 'e'])
  assertEquals(out.stopped?.reason, 'deadline')
})
