// Database tests: screen_stocks, the prices / available_dates views and the trading_days triggers, against the LOCAL
// Supabase stack loaded with supabase/seed.sql (see the stock list there).
//
//   open -a Docker && supabase start      # once per session
//   supabase db reset                     # optional: back to a clean seed
//   deno task test:db
//
// Never runs against production: the URL must be localhost (these tests insert and delete rows).

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { analyze, type Row } from '../functions/mcp/analyze.ts'

const URL = Deno.env.get('LOCAL_SUPABASE_URL') ?? 'http://127.0.0.1:54321'
// The service role key every local Supabase stack uses (public demo value, not a secret)
const KEY = Deno.env.get('LOCAL_SUPABASE_SERVICE_ROLE_KEY') ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(URL)) throw new Error(`refusing to run DB tests against ${URL}`)

const db = createClient(URL, KEY, { auth: { persistSession: false } })

const DAY = '2026-11-13' // last KRX day in the seed
const LIVE_DAY = '2026-11-16' // provisional KIS day in the seed

type Screened = {
  isu_cd: string
  history_days: number
  trdval_ratio: number | null
  volume_ratio: number | null
  trdval_up_days: number
  price_up_days: number
  price_down_days: number
  volatility: number | null
  sideways_range_pct: number | null
  sideways_trdval_growth: number | null
  high_20: number | null
  breakout_20: boolean | null
  breakout_60: boolean | null
  breakout_120: boolean | null
}

async function screen(params: Record<string, unknown> = {}): Promise<Screened[]> {
  const { data, error } = await db.rpc('screen_stocks', { p_date: DAY, ...params })
  if (error) throw new Error(`screen_stocks: ${error.message}`)
  // numeric columns can come back as strings; normalize them (but not 종목코드, which is text that looks numeric)
  const TEXT = new Set(['bas_dd', 'isu_cd', 'isu_nm', 'market'])
  return (data as Record<string, unknown>[]).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, !TEXT.has(k) && typeof v === 'string' ? Number(v) : v]))
  ) as Screened[]
}
const codes = (rows: { isu_cd: string }[]) => rows.map((r) => r.isu_cd).sort()

// Fails with a clear message when the local stack isn't up or wasn't seeded, instead of 20 confusing failures
Deno.test({
  name: 'local stack is up and seeded',
  fn: async () => {
    const { data, error } = await db.from('daily_prices').select('isu_cd').eq('bas_dd', DAY)
    assert(!error, `can't reach the local DB (${error?.message}). Run: supabase start`)
    assertEquals(data?.length, 12, 'seed not loaded or outdated. Run: supabase db reset')
  },
})

// ---- screen_stocks filters ------------------------------------------------------------------------

Deno.test('default: every traded stock, the halted one excluded', async () => {
  assertEquals(codes(await screen()), [
    '900001', '900002', '900003', '900005', '900006', '900007', '900008', '900009', '900010', '900011', '900012',
  ])
})

Deno.test('include_untraded adds the halted stock, with no breakout', async () => {
  const rows = await screen({ p_include_untraded: true, p_breakout_days: [20] })
  // the breakout filter drops it, so ask without the filter too
  assert(!codes(rows).includes('900004'))
  const halted = (await screen({ p_include_untraded: true })).find((r) => r.isu_cd === '900004')
  assert(halted, 'halted stock missing with include_untraded')
  assertEquals(halted.breakout_20, null)
})

Deno.test('market filter', async () => {
  assertEquals(codes(await screen({ p_market: 'KOSDAQ' })), ['900002', '900006', '900008', '900011'])
})

Deno.test('fluc_rt and mktcap filters', async () => {
  assertEquals(codes(await screen({ p_min_fluc_rt: 5 })), ['900001', '900007', '900008', '900009'])
  assertEquals(codes(await screen({ p_min_mktcap: 500_000_000_000 })), ['900001'])
})

Deno.test('breakouts over 20, 60 and 120 days', async () => {
  // 돌파전자 / 급등테크 / 대형강세 jump out of a flat range; 상승제약 rises every day, so it also closes above every prior high
  const rows = await screen({ p_breakout_days: [20, 60, 120] })
  assertEquals(codes(rows), ['900001', '900005', '900008', '900009'])
  const b = rows.find((r) => r.isu_cd === '900001')!
  assertEquals([b.high_20, b.breakout_20, b.breakout_60, b.breakout_120], [10100, true, true, true])
})

Deno.test('거래대금 / 거래량 spike ratio', async () => {
  const rows = await screen({ p_min_trdval_ratio: 3 })
  assertEquals(codes(rows), ['900002'])
  assertEquals(rows[0].trdval_ratio, 5)
  assertEquals(codes(await screen({ p_min_volume_ratio: 3 })), ['900002'])
})

Deno.test('box with rising 거래대금', async () => {
  const rows = await screen({ p_max_sideways_range: 5, p_min_sideways_trdval_growth: 1.9 })
  assertEquals(codes(rows), ['900003'])
  assertEquals(rows[0].sideways_range_pct, 1.51) // (20,200 − 19,900) / 19,900
  assertEquals(rows[0].sideways_trdval_growth, 2)
})

Deno.test('up streaks are capped at the short window (20 days)', async () => {
  const rows = await screen({ p_min_price_up_days: 10 })
  assertEquals(codes(rows), ['900005'])
  assertEquals(rows[0].price_up_days, 20)
})

Deno.test('volatility filter', async () => {
  // 변동금속 swings ±5% daily; 박스화학 jumped +34% into its box 19 days ago and 급등테크 +30% today, both inside the
  // 20-day window
  const rows = await screen({ p_min_volatility: 4 })
  assertEquals(codes(rows), ['900003', '900007', '900008'])
  const v = rows.find((r) => r.isu_cd === '900007')!.volatility!
  assert(v > 4 && v < 6, `volatility ${v}`)
})

Deno.test('new listing: short history gives nulls, not errors', async () => {
  const r = (await screen()).find((r) => r.isu_cd === '900006')!
  assertEquals(r.history_days, 10)
  assertEquals(r.breakout_20, null)
  assertEquals(r.sideways_range_pct, null) // fewer days than the 20-day box
  assertEquals(r.trdval_ratio, 1) // average of the 9 prior days
})

Deno.test('edge cases: rounding boundary and a tie with the prior high', async () => {
  const rows = await screen({ p_include_untraded: true })
  const round = rows.find((r) => r.isu_cd === '900010')!
  // 1.005 exactly: half up to 1.01 (floating point would give 1.0049999… and round down)
  assertEquals([round.trdval_ratio, round.volume_ratio], [1.01, 1.01])
  const tie = rows.find((r) => r.isu_cd === '900011')!
  assertEquals([tie.high_20, tie.breakout_20], [10000, false]) // close = prior high: not a breakout
})

Deno.test('sort and limit', async () => {
  const rows = await screen({ p_sort: 'trdval_ratio', p_limit: 2 })
  assertEquals(rows.length, 2)
  assertEquals(rows[0].isu_cd, '900002')
})

Deno.test('no date means the latest day, including a provisional one', async () => {
  const { data, error } = await db.rpc('screen_stocks', {})
  if (error) throw new Error(error.message)
  assertEquals((data as { bas_dd: string }[])[0].bas_dd, LIVE_DAY)
})

// ---- screen_stocks vs. analyze_stock --------------------------------------------------------------
// The two compute the same metrics in different languages (SQL vs. TypeScript). If one changes without the other,
// screen_stocks finds a stock that analyze_stock then describes differently.

Deno.test('screen_stocks and analyze() agree on every seeded stock', async () => {
  const screened = await screen({ p_include_untraded: true, p_breakout_days: null })
  const withLong = await screen({ p_include_untraded: true, p_breakout_days: [120], p_limit: 500 })
  // breakout_60/120 are only computed when asked for; the [120] filter drops non-breakouts, so look them up per stock
  const mismatches: string[] = []
  for (const s of screened) {
    // Same query as the analyze_stock tool
    const { data, error } = await db.from('prices').select('*').eq('isu_cd', s.isu_cd).lte('bas_dd', DAY)
      .order('bas_dd', { ascending: false }).limit(250)
    if (error) throw new Error(error.message)
    const a = analyze(data as Row[], { avg_days: 20, spike_ratio: 2, sideways_days: 20, sideways_max_range: 15 })
    const long = withLong.find((r) => r.isu_cd === s.isu_cd)
    // [field, analyze() value, screen_stocks value]
    const pairs: [string, unknown, unknown][] = [
      ['trdval_ratio', a.trading_value.ratio_vs_avg, s.trdval_ratio],
      ['volume_ratio', a.volume.ratio_vs_avg, s.volume_ratio],
      // analyze() counts the whole history; screen_stocks caps streaks at the 20-day window
      ['trdval_up_days', Math.min(a.trading_value.consecutive_up_days, 20), s.trdval_up_days],
      ['price_up_days', Math.min(a.streaks.consecutive_up_days, 20), s.price_up_days],
      ['price_down_days', Math.min(a.streaks.consecutive_down_days, 20), s.price_down_days],
      ['volatility', a.volatility.daily_stddev_20d_pct, s.volatility],
      ['sideways_range_pct', a.consolidation?.range_pct ?? null, s.sideways_range_pct],
      ['sideways_trdval_growth', a.consolidation?.trdval_growth ?? null, s.sideways_trdval_growth],
      ['high_20', a.breakouts.d20?.prior_high ?? null, s.high_20],
      // null (not enough history / no trades) and false both mean "no breakout"
      ['breakout_20', a.breakouts.d20?.breakout === true, s.breakout_20 === true],
      ['breakout_120', a.breakouts.d120?.breakout === true, long?.breakout_120 === true],
    ]
    for (const [field, av, sv] of pairs) {
      if (av !== sv) mismatches.push(`${s.isu_cd} ${a.name} ${field}: analyze=${av} screen_stocks=${sv}`)
    }
  }
  assertEquals(mismatches, [])
})

// ---- views and triggers ---------------------------------------------------------------------------

Deno.test('prices view hides live rows for days KRX already published', async () => {
  const { data, error } = await db.from('prices').select('close, source').eq('bas_dd', DAY).eq('isu_cd', '900001')
  if (error) throw new Error(error.message)
  assertEquals(data, [{ close: 11000, source: 'krx' }]) // not the stale KIS row (99,999)
})

Deno.test('available_dates: final KRX day vs. provisional KIS day', async () => {
  const { data, error } = await db.from('available_dates').select('*').in('bas_dd', [DAY, LIVE_DAY]).order('bas_dd')
  if (error) throw new Error(error.message)
  assertEquals(data!.map((d) => [d.bas_dd, d.row_count, d.final]), [[DAY, 12, true], [LIVE_DAY, 11, false]])
  assert(data![1].as_of, 'provisional day should have as_of')
})

Deno.test('trading_days follows inserts and deletes on daily_prices', async () => {
  const day = '2026-11-14' // not in the seed
  const row = (isu_cd: string) => ({ bas_dd: day, isu_cd, isu_nm: 'tmp', market: 'KOSPI', close: 1, trdval: 1 })
  const count = async () => (await db.from('trading_days').select('row_count').eq('bas_dd', day)).data?.[0]?.row_count
  try {
    const ins = await db.from('daily_prices').insert([row('999991'), row('999992')])
    if (ins.error) throw new Error(ins.error.message)
    assertEquals(await count(), 2)
    await db.from('daily_prices').delete().eq('bas_dd', day).eq('isu_cd', '999991')
    assertEquals(await count(), 1)
    await db.from('daily_prices').delete().eq('bas_dd', day)
    assertEquals(await count(), undefined) // day removed once empty
  } finally {
    await db.from('daily_prices').delete().eq('bas_dd', day)
  }
})

// ---- telegram sync against a changed page format ----------------------------------------------------
// Runs the real syncChannel on the local DB with t.me answered by a fake page (fetch is stubbed for t.me only; the
// Supabase client still talks to the local stack). Seeded testchannel_a has posts 1 and 2.

import { buildStockIndex, syncChannel } from '../functions/_shared/telegram.ts'

const post = (id: number, textClass: string, msgClass = 'tgme_widget_message') => `
<div class="${msgClass}" data-post="testchannel_a/${id}">
  <div class="tgme_widget_message_bubble">
    <div class="${textClass}">changed format ${id}</div>
    <span class="tgme_widget_message_views">10</span>
    <a class="tgme_widget_message_date"><time datetime="2026-11-13T0${id}:00:00+00:00"></time></a>
  </div>
</div>`
const page = (body: string) => `<html><head><meta property="og:title" content="Test Channel A"></head><body>${body}</body></html>`

async function syncWithPage(html: string) {
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.startsWith('https://t.me/')) return Promise.resolve(new Response(html, { status: 200 }))
    return realFetch(input, init)
  }) as typeof fetch
  try {
    return await syncChannel(db, 'testchannel_a', () => Promise.resolve(buildStockIndex([])), { maxPages: 1 })
  } finally {
    globalThis.fetch = realFetch
  }
}

async function channelState() {
  const { data } = await db.from('telegram_channels').select('last_error, poll_errors').eq('username', 'testchannel_a').single()
  const { data: msgs } = await db.from('telegram_messages').select('msg_id, text, views').eq('username', 'testchannel_a').order('msg_id')
  return { ...data, msgs }
}

// Put the seeded channel back exactly, so later runs (and the MCP tests) see it as before and never poll t.me
async function restoreChannel() {
  await db.from('telegram_channels').update({ last_error: null, poll_errors: 0, last_msg_id: 2, last_polled_at: '2100-01-01T00:00:00Z' })
    .eq('username', 'testchannel_a')
  await db.from('telegram_messages').update({ text: '돌파전자 신고가 돌파, HBM 수주 기대', views: 1200 }).eq('username', 'testchannel_a').eq('msg_id', 1)
  await db.from('telegram_messages').update({ text: '급증바이오 거래대금 급증', views: 800 }).eq('username', 'testchannel_a').eq('msg_id', 2)
}

Deno.test({
  name: 'telegram: renamed message class → channel marked failing, posts untouched',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      const r = await syncWithPage(page(post(1, 'tgme_widget_message_text', 'tgme_message') + post(2, 'tgme_widget_message_text', 'tgme_message')))
      assertEquals(r.ok, false)
      assert(r.error?.includes('parsed 0 of 2 posts'), r.error)
      const s = await channelState()
      assert(s.last_error?.includes('page format changed'), s.last_error ?? 'no last_error')
      assertEquals(s.poll_errors, 1)
      assertEquals(s.msgs?.map((m) => m.text), ['돌파전자 신고가 돌파, HBM 수주 기대', '급증바이오 거래대금 급증'])
    } finally {
      await restoreChannel()
    }
  },
})

Deno.test({
  name: 'telegram: renamed text class → stored text is kept, views still refresh',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      // Only 2 posts on the page (pageProblems needs 5+ to call it a format change), so the sync goes through
      const r = await syncWithPage(page(post(1, 'tgme_widget_message_body') + post(2, 'tgme_widget_message_body')))
      assertEquals(r.ok, true, r.error)
      const s = await channelState()
      assertEquals(s.msgs?.map((m) => [m.text, m.views]), [['돌파전자 신고가 돌파, HBM 수주 기대', 10], ['급증바이오 거래대금 급증', 10]])
    } finally {
      await restoreChannel()
    }
  },
})

Deno.test({
  name: 'telegram: newest page empty for a channel that had posts → failing, not "no new posts"',
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    try {
      // Even the data-post markers are gone (e.g. renamed attribute), so only the "had posts before" check can tell
      const r = await syncWithPage(page('<div class="something_new">post</div>'))
      assertEquals(r.ok, false)
      assert(r.error?.includes('channel had posts before'), r.error)
    } finally {
      await restoreChannel()
    }
  },
})
