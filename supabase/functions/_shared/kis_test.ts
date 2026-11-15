// Unit tests for KIS response parsing and the session clock, plus the MCP date helper.
// Run from the repo root: deno task test

import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { num, sessionElapsed } from './kis.ts'
import { sinceIso } from '../mcp/telegram.ts'

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

Deno.test('sinceIso: a bare date means midnight KST', () => {
  assertEquals(sinceIso('2026-11-01', 7), '2026-10-31T15:00:00.000Z')
  assertEquals(sinceIso('20261101', 7), '2026-10-31T15:00:00.000Z')
  assertEquals(sinceIso('2026-11-01T12:00:00Z', 7), '2026-11-01T12:00:00.000Z')
  assertThrows(() => sinceIso('yesterday', 7))
})

Deno.test('sinceIso: default lookback in days', () => {
  const got = new Date(sinceIso(undefined, 7)).getTime()
  const want = Date.now() - 7 * 86400_000
  assertEquals(Math.abs(got - want) < 5_000, true)
})
