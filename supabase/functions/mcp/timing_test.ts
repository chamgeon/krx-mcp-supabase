// Unit tests for per-step timings (timing.ts).
// Run from the repo root: deno task test

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { step, timeCall } from './timing.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const later = <T>(ms: number, v: T) => sleep(ms).then(() => v)

Deno.test('records sequential steps with start offsets, and returns the result', async () => {
  const r = await timeCall(async () => {
    const a = await step('a', later(20, 1))
    const b = await step('b', later(20, 2))
    return a + b
  })
  assert(r.ok)
  assertEquals(r.result, 3)
  assertEquals(r.steps.map((s) => s.step), ['a', 'b'])
  assert(r.steps[0].ms >= 15 && r.steps[1].start >= r.steps[0].start + r.steps[0].ms - 2, JSON.stringify(r.steps))
})

Deno.test('parallel steps overlap', async () => {
  const r = await timeCall(() => Promise.all([step('x', later(30, 1)), step('y', later(30, 2))]))
  assert(r.ok)
  const [x, y] = r.steps
  assert(Math.abs(x.start - y.start) < 10, 'both start together')
  assert(y.start < x.start + x.ms, 'and overlap')
})

Deno.test('steps inside helpers are found through the call context', async () => {
  const helper = () => step('helper_query', later(5, 'v'))
  const r = await timeCall(async () => {
    await sleep(5)
    return await helper()
  })
  assert(r.ok)
  assertEquals(r.steps.map((s) => s.step), ['helper_query'])
})

Deno.test('a failing step is recorded with error, and the call reports the error with its steps', async () => {
  const r = await timeCall(async () => {
    await step('ok', later(1, 0))
    await step('boom', Promise.reject(new Error('nope')))
  })
  assertEquals(r.ok, false)
  if (!r.ok) assertEquals((r.error as Error).message, 'nope')
  assertEquals(r.steps.map((s) => [s.step, s.error ?? false]), [['ok', false], ['boom', true]])
})

Deno.test('two calls at once keep separate steps', async () => {
  const [r1, r2] = await Promise.all([
    timeCall(async () => await step('one', later(20, 1))),
    timeCall(async () => await step('two', later(10, 2))),
  ])
  assertEquals([r1.steps.map((s) => s.step), r2.steps.map((s) => s.step)], [['one'], ['two']])
})

Deno.test('outside a call, step() just awaits (and rethrows)', async () => {
  assertEquals(await step('x', later(1, 42)), 42)
  await assertRejects(() => step('y', Promise.reject(new Error('e'))), Error, 'e')
})

Deno.test('supabase-js style thenables work', async () => {
  const builder = { then: (res: (v: { data: number[] }) => void) => setTimeout(() => res({ data: [1] }), 5) }
  const r = await timeCall(async () => (await step('q', builder as unknown as PromiseLike<{ data: number[] }>)).data)
  assert(r.ok)
  assertEquals(r.result, [1])
  assertEquals(r.steps.length, 1)
})
