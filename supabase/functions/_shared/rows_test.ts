// Unit tests for paging (no database). Run from the repo root: deno task test

import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.19'
import { allRows, PAGE_ROWS } from './rows.ts'

// A table of n rows served like PostgREST: at most PAGE_ROWS per request, whatever range is asked for
const table = (n: number) => {
  const asked: [number, number][] = []
  const page = (from: number, to: number) => {
    asked.push([from, to])
    const rows = Array.from({ length: Math.max(0, Math.min(n, to + 1) - from) }, (_, i) => from + i).slice(0, PAGE_ROWS)
    return Promise.resolve({ data: rows, error: null })
  }
  return { page, asked }
}

Deno.test('allRows: pages past 1,000 rows until a short page', async () => {
  const t = table(2406)
  const rows = await allRows(t.page)
  assertEquals([rows.length, rows[0], rows[2405]], [2406, 0, 2405])
  assertEquals(t.asked, [[0, 999], [1000, 1999], [2000, 2999]])
})

Deno.test('allRows: an exact multiple of the page size takes one more, empty request; none is one request', async () => {
  const t = table(2000)
  assertEquals((await allRows(t.page)).length, 2000)
  assertEquals(t.asked.length, 3)
  const e = table(0)
  assertEquals([(await allRows(e.page)).length, e.asked.length], [0, 1])
})

Deno.test('allRows: an error on any page throws', async () => {
  let n = 0
  const page = () => Promise.resolve(n++ ? { data: null, error: { message: 'timeout' } } : { data: Array(PAGE_ROWS).fill(0), error: null })
  await assertRejects(() => allRows(page), Error, 'timeout')
})
