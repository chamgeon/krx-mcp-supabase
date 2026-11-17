// Unit tests for the daily pipeline report's text (report.ts).
// Run from the repo root: deno task test

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { buildReport, reportWindowEnd, type Run } from './report.ts'

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
const healthy = {
  end: END,
  runs: [krx, kis('09:05'), kis('15:40'), kis('16:00'), tg(3), tg(2)],
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
})

Deno.test('KIS vs KRX: the comparison made when KRX replaced a day', () => {
  const withCheck = (check: object): Run => ({ ...krx, summary: { ...krx.summary, kis_check: { '20261116': check } } })
  const match = buildReport({ ...healthy, runs: [withCheck({ compared: 2771, close_mismatch: 0, examples: [] }), kis('15:40'), tg(1)] })
  assertStringIncludes(match, '✅ KIS vs KRX 11-16: all 2,771 closes match')
  const off = buildReport({
    ...healthy,
    runs: [withCheck({ compared: 2771, close_mismatch: 2, examples: ['005930 70000→70100', '000660 1→2'] }), tg(1)],
  })
  assertStringIncludes(off, '⚠️ KIS vs KRX 11-16: 2 of 2,771 closes differ (005930 70000→70100, 000660 1→2)')
})
