// Unit tests for YouTube feed parsing, which videos are stored, and what a transcript record leads to. No network.
// Run from the repo root: deno task test

import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import {
  BACKFILL_VIDEOS, clock, entriesToStore, type FeedEntry, GIVE_UP_AFTER_MS, outcomeOf, parseFeed, resolveChannel, RETRY_MINUTES,
  type Segment, transcriptMatches, transcriptPart,
} from './youtube.ts'

// Trimmed copy of youtube.com/feeds/videos.xml (only the parts parseFeed reads), with a Short and a broken entry
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>시황맨TV</title>
 <published>2019-02-19T00:19:57+00:00</published>
 <entry>
  <yt:videoId>QhyMssYKyL4</yt:videoId>
  <title>모닝 브리핑. 미 증시 &amp; 앤트로픽 &quot;시가&quot;</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=QhyMssYKyL4"/>
  <published>2026-11-19T21:36:00+00:00</published>
  <media:group><media:title>ignored</media:title><media:description>설명 &#54620;&#xAE00; 줄</media:description></media:group>
 </entry>
 <entry>
  <yt:videoId>shortAAAAAA</yt:videoId>
  <title>a Short</title>
  <link rel="alternate" href="https://www.youtube.com/shorts/shortAAAAAA"/>
  <published>2026-11-19T22:00:00+00:00</published>
 </entry>
 <entry>
  <yt:videoId>bad</yt:videoId>
  <title>broken id</title>
  <published>2026-11-19T22:00:00+00:00</published>
 </entry>
</feed>`

Deno.test('parseFeed: channel title, entries with decoded text, Shorts flagged, broken entries skipped', () => {
  const f = parseFeed(FEED)
  assertEquals(f.title, '시황맨TV')
  assertEquals(f.entries.map((e) => [e.video_id, e.short]), [['QhyMssYKyL4', false], ['shortAAAAAA', true]])
  const [e] = f.entries
  assertEquals(e.title, '모닝 브리핑. 미 증시 & 앤트로픽 "시가"')
  assertEquals(e.description, '설명 한글 줄')
  assertEquals(e.published_at, '2026-11-19T21:36:00.000Z')
})

const REAL = new URL('./fixtures/yt_feed_UC_JJ_NhRqPKcIOj5Ko3W_3w.xml', import.meta.url)
const realFeed = (() => {
  try {
    return Deno.readTextFileSync(REAL)
  } catch {
    return null
  }
})()
Deno.test({
  name: 'parseFeed: the real feed (오선의 미국 증시 라이브, 2026-11-20) has 15 entries with ids, titles and times',
  ignore: !realFeed, // gitignored fixture (third-party data): copy a feed there to run this
  fn: () => {
    const f = parseFeed(realFeed!)
    assertEquals(f.title, '오선의 미국 증시 라이브')
    assertEquals(f.entries.length, 15)
    for (const e of f.entries) {
      assert(/^[A-Za-z0-9_-]{11}$/.test(e.video_id) && e.title && !isNaN(Date.parse(e.published_at)), JSON.stringify(e))
    }
  },
})

const entry = (id: string, day: number, short = false): FeedEntry => ({
  video_id: id.padEnd(11, 'x'),
  title: id,
  description: '',
  published_at: new Date(Date.UTC(2026, 10, day)).toISOString(),
  short,
})

Deno.test('entriesToStore: a first poll keeps the newest few (no Shorts); later polls only newer, unstored ones', () => {
  const feed = [entry('a', 1), entry('b', 2), entry('s', 9, true), entry('c', 3), entry('d', 4), entry('e', 5), entry('f', 6), entry('g', 7)]
  const first = entriesToStore(feed, new Set(), null)
  assertEquals(first.length, BACKFILL_VIDEOS)
  assertEquals(first.map((e) => e.title), ['g', 'f', 'e', 'd', 'c'])
  // later: the oldest stored is c (day 3), so a and b are never filled in; g is stored, h is new
  const stored = new Set(first.map((e) => e.video_id))
  const later = entriesToStore([...feed, entry('h', 8)], stored, entry('c', 3).published_at)
  assertEquals(later.map((e) => e.title), ['h'])
})

const NOW = Date.UTC(2026, 10, 20, 6)
const pending = (attempts: number, hoursAgo = 1) => ({
  video_id: 'vvvvvvvvvvv',
  channel_id: 'UC',
  published_at: new Date(NOW - hoursAgo * 3600_000).toISOString(),
  attempts,
  language: 'ko',
})

Deno.test('outcomeOf: a transcript in the asked language is taken, segments joined', () => {
  const o = outcomeOf(pending(0), {
    success: true,
    video_id: 'vvvvvvvvvvv',
    language: 'ko',
    is_auto_generated: true,
    transcript: [{ text: '오늘 코스피는\n1.4% 상승', start: 0.4, duration: 3 }, { text: '  ', start: 3, duration: 1 }, { text: '코스닥은 3.3%', start: 4, duration: 2 }],
    metadata: { duration_seconds: 245 },
  }, NOW)
  assertEquals(o.status, 'ok')
  if (o.status !== 'ok') return
  assertEquals([o.transcript, o.lang, o.auto, o.duration], ['오늘 코스피는 1.4% 상승 코스닥은 3.3%', 'ko', true, 245])
})

Deno.test('outcomeOf: no transcript yet is retried with a growing pause, given up on after 48 h', () => {
  const noCaptions = { success: false, video_id: 'vvvvvvvvvvv', code: 'NO_TRANSCRIPT', error: 'none yet' }
  for (const [attempts, wait] of [[0, RETRY_MINUTES[0]], [2, RETRY_MINUTES[2]], [99, RETRY_MINUTES.at(-1)!]]) {
    const o = outcomeOf(pending(attempts), noCaptions, NOW)
    assertEquals(o.status, 'pending')
    if (o.status === 'pending') assertEquals(Date.parse(o.next_attempt_at!) - NOW, wait * 60_000)
  }
  const old = outcomeOf(pending(5, GIVE_UP_AFTER_MS / 3600_000 + 1), noCaptions, NOW)
  assertEquals([old.status, old.status !== 'ok' && old.error], ['none', 'NO_TRANSCRIPT: none yet'])
})

Deno.test('outcomeOf: another language is not taken; a bad id fails for good; a missing record waits', () => {
  const english = outcomeOf(pending(0), { success: true, video_id: 'vvvvvvvvvvv', language: 'en', transcript: [{ text: 'hi', start: 0, duration: 1 }] }, NOW)
  assertEquals([english.status, english.status !== 'ok' && english.error], ['pending', 'only a en transcript, not ko'])
  const bad = outcomeOf(pending(0), { success: false, video_id: 'vvvvvvvvvvv', code: 'VALIDATION_FAILED', error: 'must be 11 characters' }, NOW)
  assertEquals(bad.status, 'failed')
  assertEquals(outcomeOf(pending(0), undefined, NOW).status, 'pending')
})

// ---- reading transcripts in parts ----

// 5 minutes, a segment every 15 s, 20 characters each
const SEGS: Segment[] = Array.from({ length: 20 }, (_, i) => ({ start: i * 15 + 0.4, duration: 14, text: `구간${String(i).padStart(2, '0')} 텍스트입니다 ...` }))

Deno.test('clock: m:ss, and h:mm:ss past an hour', () => {
  assertEquals([clock(0), clock(75.9), clock(3725)], ['0:00', '1:15', '1:02:05'])
})

Deno.test('transcriptPart: parts cut at a segment, a [m:ss] marker each minute, next_from until the end', () => {
  const p1 = transcriptPart(SEGS, 0, 200)
  assert(p1.text.startsWith('[0:00] 구간00'), p1.text)
  assert(p1.text.length <= 200 && p1.next_from !== null)
  // the next part starts where the first stopped, and the parts together are the whole transcript, once each
  const parts = [p1.text]
  let from: number | null = p1.next_from
  while (from !== null) {
    const p = transcriptPart(SEGS, from, 200)
    parts.push(p.text)
    from = p.next_from
  }
  const all = parts.join(' ')
  for (let i = 0; i < 20; i++) assertEquals(all.split(`구간${String(i).padStart(2, '0')}`).length - 1, 1, `segment ${i}`)
  assertEquals((all.match(/\[\d+:\d\d\]/g) ?? []).length >= 5, true) // one marker per minute at least
  // from a time: starts at the first segment at or after it; past the end: nothing
  assert(transcriptPart(SEGS, 120, 6000).text.startsWith('[2:00] 구간08'))
  assertEquals(transcriptPart(SEGS, 999, 6000).from, null)
  // one segment longer than max_chars still comes back (never an empty part)
  assertEquals(transcriptPart([{ start: 0, duration: 1, text: 'x'.repeat(50) }], 0, 10).text, '[0:00] ' + 'x'.repeat(50))
})

Deno.test('transcriptMatches: excerpts with the time they start at; spacing ignored; overlapping hits merged', () => {
  const segs: Segment[] = [
    { start: 0, duration: 5, text: '오늘 시황입니다' },
    { start: 65, duration: 5, text: '엔트 로픽 상장 이야기' },
    { start: 70, duration: 5, text: '엔트로픽 다시' },
    { start: 300, duration: 5, text: '마지막으로 엔트로픽' },
  ]
  const m = transcriptMatches(segs, '엔트로픽', 8, 3)
  assertEquals(m.map((x) => x.time), ['1:05', '1:10', '5:00'])
  assert(m[0].excerpt.includes('엔트 로픽'), m[0].excerpt)
  assertEquals(transcriptMatches(segs, '엔트로픽', 8, 200).length, 1) // one wide excerpt covers all three
  assertEquals(transcriptMatches(segs, '없는말'), [])
})

Deno.test('resolveChannel: ids and links directly, @handles from the channel page, unknown ones null', async () => {
  const id = 'UC_JJ_NhRqPKcIOj5Ko3W_3w'
  const calls: string[] = []
  const page = ((url: string) => {
    calls.push(url)
    return Promise.resolve(url.endsWith('/@missing')
      ? new Response('not found', { status: 404 })
      : new Response(`<html><link rel="canonical" href="https://www.youtube.com/channel/${id}"></html>`))
  }) as unknown as typeof fetch
  for (const s of [id, `https://www.youtube.com/channel/${id}`, `youtube.com/channel/${id}/videos`]) {
    assertEquals(await resolveChannel(s, page), id, s)
  }
  assertEquals(calls, []) // no lookup needed
  for (const s of ['@futuresnow', 'https://www.youtube.com/@futuresnow', 'm.youtube.com/@futuresnow/videos', '@기릿의주식노트']) {
    assertEquals(await resolveChannel(s, page), id, s)
  }
  assertEquals(calls.at(-1), `https://www.youtube.com/@${encodeURIComponent('기릿의주식노트')}`)
  assertEquals(await resolveChannel('@missing', page), null)
  assertEquals(await resolveChannel('just some words', page), null)
})
