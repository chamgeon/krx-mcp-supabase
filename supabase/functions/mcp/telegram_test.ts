// Unit tests for the MCP Telegram tools' helpers.
// Run from the repo root: deno task test

import { assertEquals, assertThrows } from 'jsr:@std/assert@1.0.19'
import { asParts, feedChannels, partsByPost, sinceIso } from './telegram.ts'

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

Deno.test('partsByPost: chunks grouped per wanted post, in order, with their tags merged once', () => {
  const c = (username: string, msg_id: number, idx: number, text: string, us: string[], events: string[] = []) =>
    ({ username, msg_id, idx, text, stock_codes: [], us_tickers: us, events })
  const parts = partsByPost([
    c('digest', 7, 0, 'Anthropic part', ['ANT'], ['anthropic-ipo']),
    c('digest', 7, 3, 'Anthropic and Nvidia', ['ANT', 'NVDA'], ['anthropic-ipo']),
    c('other', 7, 0, 'same msg_id, another channel', ['TSLA']),
  ], new Set(['digest/7']))
  assertEquals([...parts.keys()], ['digest/7'])
  assertEquals(parts.get('digest/7'), {
    texts: ['Anthropic part', 'Anthropic and Nvidia'],
    stock_codes: [],
    us_tickers: ['ANT', 'NVDA'],
    events: ['anthropic-ipo'],
  })
})

Deno.test("asParts: a post shown as parts lists the parts' tags, not the whole post's; others unchanged", () => {
  const post = {
    username: 'digest', msg_id: 7, ts: '2026-11-26T00:00:00Z', text: 'the whole digest', views: 1, forwarded_from: null,
    has_media: false, links: [], stock_codes: ['005930'], us_tickers: ['ANT', 'AZN', 'CPNG', 'META'],
    events: ['amd-short-report', 'anthropic-ipo'], label: 'market' as const,
  }
  const parts = { texts: ['part one', 'part two'], stock_codes: [], us_tickers: ['ANT'], events: ['anthropic-ipo'] }
  const shown = asParts(post, parts, 1500)
  assertEquals([shown.text, shown.stock_codes, shown.us_tickers, shown.events], ['part one\n…\npart two', [], ['ANT'], ['anthropic-ipo']])
  assertEquals(asParts(post, parts, 10).text, 'part one\n…' + '…')
  assertEquals(asParts(post, undefined, 1500), post)
})
