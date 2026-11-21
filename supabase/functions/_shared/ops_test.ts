// Unit tests for the ingest run record and alerts (ops.ts): what is stored and said about a run.
// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { errorOf, kstTime, summaryOf } from './ops.ts'

Deno.test('errorOf: each ingest function reports failures its own way', () => {
  // kis-ingest
  assertEquals(errorOf({ date: '20261117', error: 'refused snapshot: 40% of stocks missing' }), 'refused snapshot: 40% of stocks missing')
  // krx-ingest: one day failed, one loaded
  assertEquals(
    errorOf({ targets: ['20261116', '20261117'], results: { '20261116': 2789, '20261117': 'error: KRX stk_bydd_trd 20261117: HTTP 401' } }),
    '20261117: KRX stk_bydd_trd 20261117: HTTP 401',
  )
  // telegram-ingest: one channel failed
  assertEquals(
    errorOf({ polled: 2, results: [{ channel: 'a', ok: true, new_posts: 1 }, { channel: 'b', ok: false, error: 'no posts parsed' }] }),
    'b: no posts parsed',
  )
  // youtube-ingest: a channel failed and the transcript call failed as a whole
  assertEquals(
    errorOf({ polled: 2, results: [{ channel: 'UCa', ok: false, error: 'feed UCa: HTTP 404' }], transcripts: { error: 'transcripts: apify: HTTP 401: x' } }),
    'UCa: feed UCa: HTTP 404; transcripts: apify: HTTP 401: x',
  )
  // nothing recognizable: the caller falls back to the HTTP status
  assertEquals(errorOf({ results: { '20261117': 2789 } }), null)
  assertEquals(errorOf(null), null)
  assertEquals(errorOf('not json'), null)
})

Deno.test('summaryOf keeps only failed Telegram channels; other answers as they are', () => {
  const tg = { polled: 2, new_posts: 3, results: [{ channel: 'a', ok: true }, { channel: 'b', ok: false, error: 'x' }] }
  assertEquals(summaryOf(tg), { polled: 2, new_posts: 3, results: [{ channel: 'b', ok: false, error: 'x' }] })
  const kis = { date: '20261117', rows: 2771, as_of: '2026-11-17T06:40:00Z' }
  assertEquals(summaryOf(kis), kis)
  assertEquals(summaryOf(null), null)
})

Deno.test('kstTime', () => {
  assertEquals(kstTime(new Date('2026-11-17T06:40:00Z')), '11-17 15:40')
  assertEquals(kstTime(new Date('2026-11-17T15:30:00Z')), '11-18 00:30') // after midnight KST
})

Deno.test('errorOf: a Telegram poll that stopped early is named first', () => {
  assertEquals(
    errorOf({
      results: [{ channel: 'a', ok: false, error: 'no answer in 10 s' }, { channel: 'b', ok: false, error: 'no answer in 10 s' }],
      poll_stopped: 't.me unreachable: 2 channels in a row gave no answer',
      not_polled: ['c'],
    }),
    't.me unreachable: 2 channels in a row gave no answer; a: no answer in 10 s; b: no answer in 10 s',
  )
})
