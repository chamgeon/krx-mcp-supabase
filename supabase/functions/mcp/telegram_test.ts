// Unit tests for the MCP Telegram tools' helpers.
// Run from the repo root: deno task test

import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { sinceIso } from './telegram.ts'

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
