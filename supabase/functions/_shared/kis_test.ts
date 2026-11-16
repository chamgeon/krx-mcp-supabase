// Unit tests for KIS response parsing and the session clock.
// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1'
import { num, sessionElapsed } from './kis.ts'

Deno.test('num parses KIS number strings', () => {
  assertEquals(num('1,234'), 1234)
  assertEquals(num(' -3.5 '), -3.5)
  assertEquals(num(42), 42)
  assertEquals(num(''), null)
  assertEquals(num('-'), null)
  assertEquals(num('abc'), null)
  assertEquals(num(null), null)
  assertEquals(num(undefined), null)
})

// KST = UTC+9, so 09:00 KST is 00:00 UTC and 15:30 KST is 06:30 UTC
Deno.test('sessionElapsed over the 09:00–15:30 KST session', () => {
  assertEquals(sessionElapsed(new Date('2026-11-13T23:30:00Z')), 0) // 08:30 KST, before the open
  assertEquals(sessionElapsed(new Date('2026-11-13T00:00:00Z')), 0) // 09:00 open
  assertEquals(sessionElapsed(new Date('2026-11-13T03:15:00Z')), 0.5) // 12:15, halfway
  assertEquals(sessionElapsed(new Date('2026-11-13T06:30:00Z')), 1) // 15:30 close
  assertEquals(sessionElapsed(new Date('2026-11-13T10:00:00Z')), 1) // 19:00 KST, after close
})
