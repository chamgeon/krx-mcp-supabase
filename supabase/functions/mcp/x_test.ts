// Unit test for get_x_feed's size cap (fitPosts). No database.
// Run from the repo root: deno task test

import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import { FEED_MAX_BYTES, fitPosts } from './x.ts'

const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 1)).length
const make = (posts: { text: string }[], leftOut: number) => ({ count: posts.length, posts, ...(leftOut ? { truncated: `${leftOut} left out` } : {}) })
const post = (i: number, chars: number, ch = 'x') => ({ text: `${i} ${ch.repeat(chars)}` })

Deno.test('fitPosts: an answer over 64 KB keeps the newest posts that fit and says how many were left out', () => {
  for (const [chars, ch] of [[2000, 'x'], [700, '한']] as const) { // English, and Korean at 3 bytes a character
    const posts = Array.from({ length: 100 }, (_, i) => post(i, chars, ch))
    const a = fitPosts(make, posts) as ReturnType<typeof make>
    assert(size(a) <= FEED_MAX_BYTES, `${size(a)} bytes`)
    assert(a.count < 100 && a.count > 20, `${a.count} posts`)
    assertEquals(a.truncated, `${100 - a.count} left out`)
    assertEquals(a.posts[0].text.startsWith('0 '), true) // the newest first, kept
    // as many as fit: one more would not
    assert(size(make(posts.slice(0, a.count + 1), 100 - a.count - 1)) > FEED_MAX_BYTES)
  }
})

Deno.test('fitPosts: a small answer is untouched; a single post over the limit still comes back', () => {
  const few = [post(1, 100), post(2, 100)]
  assertEquals(fitPosts(make, few), make(few, 0))
  const huge = [post(1, 70_000), post(2, 10)]
  assertEquals((fitPosts(make, huge) as ReturnType<typeof make>).count, 1)
})
