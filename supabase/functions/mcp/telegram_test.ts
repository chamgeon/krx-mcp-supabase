// Unit tests for the MCP Telegram tools' helpers.
// Run from the repo root: deno task test

import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { feedChannels, sinceIso } from './telegram.ts'

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

Deno.test('feedChannels: shown, today and window counts per channel, busiest first', () => {
  const row = (username: string, is_today: boolean, in_window: number, today: number) =>
    ({ username, is_today, in_window, today }) as Parameters<typeof feedChannels>[0][number]
  assertEquals(
    feedChannels([row('busy', true, 260, 68), row('quiet', true, 6, 1), row('busy', true, 260, 68), row('busy', false, 260, 68)]),
    [
      { channel: 'busy', shown: 3, shown_today: 2, today: 68, in_window: 260 },
      { channel: 'quiet', shown: 1, shown_today: 1, today: 1, in_window: 6 },
    ],
  )
  assertEquals(feedChannels([]), [])
})
