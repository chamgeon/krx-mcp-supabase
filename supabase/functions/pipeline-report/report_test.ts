// Unit tests for the daily pipeline report's text (report.ts).
// Run from the repo root: deno task test

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.19'
import { buildReport, gateReport, marketReport, reportWindowEnd, type Run, youtubeReport } from './report.ts'

const END = new Date('2026-11-17T09:00:00Z') // Tue 18:00 KST
const at = (kst: string) => new Date(`2026-11-17T${kst}:00+09:00`).toISOString()

const kis = (time: string, rows = 2771): Run => ({
  job: 'kis-ingest', started_at: at(time), ok: true, error: null,
  summary: { date: '20261117', rows, as_of: at(time) },
})
const krx: Run = {
  job: 'krx-ingest', started_at: at('07:00'), ok: true, error: null,
  summary: { targets: ['20261116', '20261117'], results: { '20261116': 2789, '20261117': 0 } },
}
const tg = (newPosts: number): Run => ({ job: 'telegram-ingest', started_at: at('10:00'), ok: true, error: null, summary: { new_posts: newPosts } })
const mk = (set: string, iso: string, ok = true, summary: object = {}): Run =>
  ({ job: `market-ingest-${set}`, started_at: new Date(iso).toISOString(), ok, error: ok ? null : 'x', summary })
// The window (Mon 18:00 → Tue 18:00 KST): live through the day, bonds Mon 18:30, US Mon night → Tue morning
const markets = [
  mk('live', '2026-11-17T09:01:00+09:00'), mk('live', '2026-11-17T17:56:00+09:00'),
  mk('bonds', '2026-11-16T18:30:00+09:00'),
  mk('us', '2026-11-17T05:03:00+09:00', true, { stored: 650 }), mk('us', '2026-11-17T06:58:00+09:00', true, { stored: 651 }),
  mk('global', '2026-11-17T17:50:00+09:00'),
]
const yt = (newVideos: number, t: object = {}, ok = true): Run => ({
  job: 'youtube-ingest', started_at: at('10:02'), ok, error: ok ? null : 'x',
  summary: { new_videos: newVideos, transcripts: { fetched: 0, waiting: 0, none: 0, failed: 0, left: 0, ...t } },
})
const healthy = {
  end: END,
  runs: [krx, kis('09:05'), kis('15:40'), kis('16:00'), tg(3), tg(2), yt(2, { fetched: 1 }), yt(0, { fetched: 1 }), ...markets],
  pendingKrxDays: [],
  krxLatest: { bas_dd: '2026-11-16', row_count: 2789 },
  channelErrors: [],
}

Deno.test('report window: the latest 18:00 KST at or before now', () => {
  assertEquals(reportWindowEnd(new Date('2026-11-17T09:00:30Z')), END) // sent at 18:00:30
  assertEquals(reportWindowEnd(new Date('2026-11-17T08:59:00Z')), new Date('2026-11-16T09:00:00Z')) // 17:59: yesterday's
})

Deno.test('a healthy trading day', () => {
  assertEquals(buildReport(healthy), [
    '📊 Data pipeline · 11-17 (Tue)',
    '✅ KIS: 3 snapshots today, last 16:00 (2,771 stocks)',
    '✅ KRX official: latest 11-16 (2,789 stocks), loaded 11-16',
    '✅ Telegram: 2 polls, 5 new posts',
    '✅ YouTube: 2 polls, 2 new videos, 2 transcripts fetched',
    '✅ Markets: KR 2 runs, last 17:56; KR bonds 18:30; US 2 runs, last 06:58, 651 stocks; gold/silver/BTC 17:50',
    '✅ No failed runs since yesterday 18:00',
  ].join('\n'))
})

Deno.test('failures, a missing KRX day and a failing channel are flagged', () => {
  const text = buildReport({
    ...healthy,
    runs: [
      ...healthy.runs,
      { job: 'kis-ingest', started_at: at('10:00'), ok: false, error: 'refused snapshot: x', summary: { date: '20261117' } },
      { job: 'kis-ingest', started_at: at('10:05'), ok: false, error: 'refused snapshot: y', summary: { date: '20261117' } },
    ],
    pendingKrxDays: ['2026-11-16'],
    channelErrors: [{ username: 'somechan', last_error: 'no public preview' }],
  })
  assertStringIncludes(text, '❌ KRX official: 11-16 not loaded (only KIS data)')
  assertStringIncludes(text, '⚠️ Telegram channels failing: somechan (no public preview)')
  assertStringIncludes(text, '❌ kis-ingest: 2 failed runs, last 11-17 10:05: refused snapshot: y')
  assert(!text.includes('No failed runs'))
})

Deno.test('a trading day without a snapshot after the close, or without any', () => {
  assertStringIncludes(buildReport({ ...healthy, runs: [krx, kis('09:05'), tg(1)] }), '⚠️ KIS: 1 snapshot today, last 09:05')
  assertStringIncludes(buildReport({ ...healthy, runs: [krx, tg(1)] }), "❌ KIS: kis-ingest didn't run today")
})

Deno.test('weekend and weekday holiday: short "market closed" report, no KIS line', () => {
  const sat = buildReport({ ...healthy, end: new Date('2026-11-21T09:00:00Z'), runs: [krx, tg(4)] })
  assertStringIncludes(sat, '· market closed')
  assert(!sat.includes('KIS'))
  const holiday: Run = {
    job: 'kis-ingest', started_at: at('09:05'), ok: true, error: null,
    summary: { date: '20261117', skipped: 'not a trading day (latest is 20261116)' },
  }
  const text = buildReport({ ...healthy, runs: [krx, holiday, tg(1)] })
  assertStringIncludes(text, '11-17 (Tue) · market closed')
  assert(!text.includes('KIS:'))
})

Deno.test('jobs that never ran are flagged', () => {
  const text = buildReport({ ...healthy, runs: [kis('15:40')] })
  assertStringIncludes(text, "❌ KRX: krx-ingest didn't run (07:00–08:30)")
  assertStringIncludes(text, "❌ Telegram: telegram-ingest didn't run")
  assertStringIncludes(text, "❌ YouTube: youtube-ingest didn't run")
  assertStringIncludes(text, "❌ Markets: market-ingest-live didn't run; market-ingest-bonds didn't run; market-ingest-us didn't run; market-ingest-global didn't run")
})

Deno.test('YouTube: videos waiting now, given up or failed, a job that never ran or never succeeded', () => {
  const runs = [yt(1, { fetched: 1, waiting: 3 }), yt(0, { none: 1 })]
  assertEquals(
    youtubeReport(runs, { count: 1, oldest: '2026-11-16T12:14:30Z' }),
    '⚠️ YouTube: 2 polls, 1 new video, 1 transcript fetched, 1 waiting for captions (oldest uploaded 11-16 21:14); 1 without a transcript after 48 h',
  )
  assertEquals(youtubeReport([yt(0, { failed: 2 })]), '⚠️ YouTube: 1 poll, 0 new videos, 0 transcripts fetched; 2 failed')
  assertEquals(youtubeReport([], { count: 0, oldest: null }), "❌ YouTube: youtube-ingest didn't run")
  assertEquals(youtubeReport([yt(0, {}, false), yt(0, {}, false)]), '❌ YouTube: no successful run (2 failed runs)')
})

Deno.test('markets: a set with only failed runs is flagged, the others listed as ok', () => {
  const runs = [...markets.filter((r) => r.job !== 'market-ingest-us'), mk('us', '2026-11-17T05:03:00+09:00', false), mk('us', '2026-11-17T05:08:00+09:00', false)]
  assertEquals(
    marketReport(runs, 2),
    '❌ Markets: market-ingest-us: no successful run (2 failed runs) (ok: KR 2 runs, last 17:56; KR bonds 18:30; gold/silver/BTC 17:50)',
  )
})

Deno.test('markets: what each day expects (Sun global only, Mon live + global, Sat all: Friday night is in the window)', () => {
  const g = mk('global', '2026-11-16T17:50:00+09:00')
  assertEquals(marketReport([g], 0), '✅ Markets: gold/silver/BTC 17:50') // Sunday: only the 24/7 set
  assertEquals(marketReport([], 0), "❌ Markets: market-ingest-global didn't run")
  assertEquals(marketReport([g], 1), "❌ Markets: market-ingest-live didn't run (ok: gold/silver/BTC 17:50)") // Monday: no bonds / US on Sunday
  assertEquals(marketReport([g], 6), "❌ Markets: market-ingest-live didn't run; market-ingest-bonds didn't run; market-ingest-us didn't run (ok: gold/silver/BTC 17:50)")
  assertEquals(marketReport([mk('live', '2026-11-16T09:01:00+09:00'), g], 1), '✅ Markets: KR 09:01; gold/silver/BTC 17:50')
})

Deno.test('Telegram gate: posts, noise share, tokens and cost over the day; off when no run gated', () => {
  const run = (gate: unknown, extra: object = {}): Run => ({ ...tg(1), summary: { new_posts: 1, gate, ...extra } })
  const g = (gated: number, noise: number, left: number, failed = 0) => ({ gated, noise, failed, left, tokens: { input: gated * 1500, output: gated * 100 } })
  assertEquals(gateReport([tg(1), tg(2)]), null)
  // 120 posts, 18 noise; 180K in at $0.10/M + 12K out at $0.50/M = $0.024
  assertEquals(gateReport([run(g(40, 6, 400)), run(g(40, 5, 360)), run(g(40, 7, 320))]),
    '✅ Telegram gate: 120 posts gated, 15% noise (18), 320 still ungated · 180K in / 12K out tokens ≈ $0.02') // the backlog after the last run
  assertStringIncludes(gateReport([run(g(38, 3, 0, 2))])!, '⚠️ Telegram gate: 38 posts gated')
  assertStringIncludes(gateReport([run(g(38, 3, 0, 2))])!, '2 failed calls')
  assertStringIncludes(gateReport([run(g(10, 1, 0)), run({ error: 'gate: every call failed: 401' })])!, '❌ Telegram gate: 10 posts gated, 10% noise (1), 1 run with every call failing')
  // in the report, under the polls; a gate-only run (?gate=N) isn't a poll
  const text = buildReport({ ...healthy, runs: [krx, kis('09:05'), kis('15:40'), kis('16:00'), run(g(2, 0, 0)), run(g(300, 30, 0), { gate_only: true })] })
  assertStringIncludes(text, '✅ Telegram: 1 poll, 1 new post\n✅ Telegram gate: 302 posts gated, 10% noise (30)')
})
