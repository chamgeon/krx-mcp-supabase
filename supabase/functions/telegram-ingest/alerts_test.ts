// Unit tests for the Telegram channel alerts (alerts.ts).
// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1.0.19'
import type { SyncResult } from '../_shared/telegram.ts'
import { channelAlerts } from './alerts.ts'

const ok = (channel: string): SyncResult => ({ channel, ok: true, new_posts: 0, pages: 1 })
const fail = (channel: string, error = 'no posts parsed'): SyncResult => ({ channel, ok: false, new_posts: 0, pages: 1, error })

Deno.test('a channel that starts failing alerts; one that stays broken does not', () => {
  const before = new Map([['healthy', 0], ['broken', 3]])
  assertEquals(channelAlerts(before, [fail('healthy'), fail('broken')]), '❌ Telegram channel healthy started failing: no posts parsed')
  assertEquals(channelAlerts(new Map([['broken', 4]]), [fail('broken')]), null) // the hourly retry: silent
})

Deno.test('a channel that works again says so; nothing changed means no alert', () => {
  assertEquals(channelAlerts(new Map([['back', 5]]), [ok('back')]), '✅ Telegram channel back works again')
  assertEquals(channelAlerts(new Map([['a', 0], ['b', 0]]), [ok('a'), ok('b')]), null)
  assertEquals(channelAlerts(new Map(), []), null)
})

Deno.test('a new channel (no poll_errors yet) counts as healthy before', () => {
  assertEquals(channelAlerts(new Map(), [fail('new', 'x')]), '❌ Telegram channel new started failing: x')
})
