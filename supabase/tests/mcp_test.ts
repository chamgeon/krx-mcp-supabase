// MCP smoke tests: the real mcp Edge Function, served locally over HTTP and called with the official MCP client,
// the same way ChatGPT / Claude call it. Data comes from supabase/seed.sql.
//
//   supabase start
//   supabase functions serve mcp --env-file supabase/tests/functions.env     # in a second terminal
//   deno task test:mcp
//
// Checks the shape and wiring of every tool, auth, and usage logging. The numbers themselves are covered by the
// unit tests (analyze_test.ts) and the DB tests (db_test.ts). No test reaches KIS, KRX or t.me: analyze_stock always
// gets a past date (no live quote), seeded channels are never stale, and add_telegram_channel is only called with an
// invalid name.

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { Client, StreamableHTTPClientTransport } from 'npm:@modelcontextprotocol/client@2.4.0'
import { createClient } from 'npm:@supabase/supabase-js@2'

const BASE = Deno.env.get('LOCAL_SUPABASE_URL') ?? 'http://127.0.0.1:54321'
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(BASE)) throw new Error(`refusing to run MCP tests against ${BASE}`)
const MCP = `${BASE}/functions/v1/mcp`
const KEY = 'local-test-key' // MCP_ACCESS_KEY in supabase/tests/functions.env
// Keys every local Supabase stack uses (public demo values, not secrets)
const SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

const admin = createClient(BASE, SERVICE_KEY, { auth: { persistSession: false } })

const DAY = '2026-11-13' // last KRX day in the seed
const LIVE_DAY = '2026-11-16' // provisional KIS day in the seed (11:00 KST snapshot)

// ---- helpers --------------------------------------------------------------------------------------

// The MCP client keeps HTTP streams open between calls; Deno's leak checks would flag them
function test(name: string, fn: () => Promise<void>) {
  Deno.test({ name, fn, sanitizeResources: false, sanitizeOps: false })
}

async function connect(
  auth: { key: string } | { token: string },
  userAgent?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Client> {
  const url = new URL(MCP)
  const headers: Record<string, string> = { ...extraHeaders, ...(userAgent ? { 'User-Agent': userAgent } : {}) }
  if ('key' in auth) url.searchParams.set('key', auth.key)
  else headers.Authorization = `Bearer ${auth.token}`
  const client = new Client({ name: 'krx-mcp-tests', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
  return client
}

let shared: Client | null = null
const keyClient = async () => (shared ??= await connect({ key: KEY }))

type Json = Record<string, any>

// Calls a tool and returns its JSON payload; fails if the call itself errored
async function call(name: string, args: Json = {}, client?: Client): Promise<Json> {
  const c = client ?? await keyClient()
  const r = await c.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] }
  assert(!r.isError, `${name} returned isError: ${r.content?.[0]?.text}`)
  assertEquals(r.content[0].type, 'text')
  return JSON.parse(r.content[0].text)
}

// A logged-in user from local Supabase Auth (ES256 token, like production)
const USER = { email: 'mcp-test@example.com', password: 'mcp-test-password-1' }
let userToken: { token: string; id: string } | null = null
async function testUser() {
  if (userToken) return userToken
  const created = await admin.auth.admin.createUser({ ...USER, email_confirm: true })
  if (created.error && !/already/i.test(created.error.message)) throw new Error(created.error.message)
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(USER),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`sign in: ${JSON.stringify(body)}`)
  userToken = { token: body.access_token, id: body.user.id }
  return userToken
}

// tool_calls rows are written after the response (EdgeRuntime.waitUntil), so poll briefly
async function waitForLog(match: (q: any) => any): Promise<Json> {
  for (let i = 0; i < 30; i++) {
    const { data, error } = await match(admin.from('tool_calls').select('*')).order('id', { ascending: false }).limit(1)
    if (error) throw new Error(error.message)
    if (data?.length) return data[0]
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('no tool_calls row appeared')
}

// ---- reachability ---------------------------------------------------------------------------------

test('local MCP server is up, with the test env', async () => {
  let res: Response
  try {
    res = await fetch(`${MCP}?key=${KEY}`, { method: 'GET' })
  } catch (e) {
    throw new Error(`can't reach ${MCP} (${(e as Error).message}). Run: supabase functions serve mcp --env-file supabase/tests/functions.env`)
  }
  await res.body?.cancel()
  // A wrong key would get the 401 "login required"; anything else means the test key was accepted
  assert(res.status !== 401, 'test key rejected: serve was started without --env-file supabase/tests/functions.env')
})

// ---- auth -----------------------------------------------------------------------------------------

test('no token: 401 pointing clients to the OAuth metadata', async () => {
  const res = await fetch(MCP, { method: 'POST' })
  assertEquals(res.status, 401)
  assertEquals((await res.json()).error_description, 'login required')
  assertEquals(
    res.headers.get('www-authenticate'),
    `Bearer resource_metadata="${MCP}/.well-known/oauth-protected-resource", scope="offline_access"`,
  )
})

test('protected resource metadata names Supabase Auth', async () => {
  const res = await fetch(`${MCP}/.well-known/oauth-protected-resource`)
  assertEquals(await res.json(), {
    resource: MCP,
    authorization_servers: [`${BASE}/auth/v1`],
    bearer_methods_supported: ['header'],
    scopes_supported: ['offline_access'],
    resource_name: 'kr-stock-movers',
  })
})

test('wrong ?key= and invalid tokens are rejected', async () => {
  const wrongKey = await fetch(`${MCP}?key=nope`, { method: 'POST' })
  assertEquals(wrongKey.status, 401)
  await wrongKey.body?.cancel()

  const garbage = await fetch(MCP, { method: 'POST', headers: { Authorization: 'Bearer not-a-jwt' } })
  assertEquals(garbage.status, 401)
  assertStringIncludes((await garbage.json()).error_description, 'invalid token')

  // A real JWT, but the anon key (HS256, role anon), not a user token from Auth
  const anon = await fetch(MCP, { method: 'POST', headers: { Authorization: `Bearer ${ANON_KEY}` } })
  assertEquals(anon.status, 401)
  await anon.body?.cancel()
})

test('a valid login that is not on ALLOWED_USERS gets a 403, not the tools', async () => {
  const outsider = { email: 'mcp-outsider@example.com', password: 'mcp-outsider-password-1' }
  const created = await admin.auth.admin.createUser({ ...outsider, email_confirm: true })
  if (created.error && !/already/i.test(created.error.message)) throw new Error(created.error.message)
  const signIn = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(outsider),
  })
  const { access_token } = await signIn.json()
  assert(access_token, 'outsider signed in')
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.error, 'forbidden')
  assertStringIncludes(body.error_description, 'invite-only')
})

test('a logged-in user token works', async () => {
  const { token } = await testUser()
  const client = await connect({ token })
  const r = await call('get_my_channels', {}, client)
  assert(Array.isArray(r.channels), JSON.stringify(r)) // not the LOGIN_REQUIRED error
  await client.close()
})

// ---- tool list ------------------------------------------------------------------------------------

test('tools/list: exactly the expected tools, each described', async () => {
  const { tools } = await (await keyClient()).listTools()
  assertEquals(tools.map((t) => t.name).sort(), [
    'add_telegram_channel', 'analyze_stock', 'check_available_dates', 'find_stock', 'get_daily_movers', 'get_my_channels',
    'get_stock_history', 'get_telegram_feed', 'list_telegram_channels', 'screen_stocks', 'search_telegram',
    'set_my_channels', 'update_my_channels',
  ])
  for (const t of tools) {
    assert((t.description ?? '').length > 20, `${t.name} has no real description`)
    assertEquals(t.inputSchema.type, 'object', `${t.name} input schema`)
  }
})

// ---- market data tools ----------------------------------------------------------------------------

test('get_daily_movers: sheets on a final day', async () => {
  const r = await call('get_daily_movers', { date: DAY })
  assertEquals(r.date, DAY)
  assertEquals(r.data_status, '확정치 (KRX official)')
  assertEquals(r.sheet1.map((s: Json) => s.종목코드), ['900008']) // +30%
  assertEquals(r.sheet2.map((s: Json) => s.종목코드), ['900009']) // +8%, 600억
  assertEquals([r.sheet1_count, r.sheet2_count], [1, 1])
  const s = r.sheet2[0]
  assertEquals([s.종목명, s.등락률, s.종가, s.거래대금_억원, s.시장], ['대형강세', 8, 54000, 600, 'KOSPI'])
  assertEquals(r.sheet3_charts.map((c: Json) => c.종목코드), ['900008', '900009'])
  assertStringIncludes(r.sheet3_charts[0].일봉, '900008')
})

test('get_daily_movers: latest day is the intraday snapshot, with a warning', async () => {
  const r = await call('get_daily_movers')
  assertEquals(r.date, LIVE_DAY)
  assertEquals(r.data_status, '장중 (intraday, provisional)')
  assertEquals(r.as_of, '2026-11-16 11:00 KST')
  assertEquals(r.session_elapsed, 0.31)
  assert(r.intraday_warning)
})

test('get_daily_movers: a weekend says so', async () => {
  const r = await call('get_daily_movers', { date: '20261114' })
  assertStringIncludes(r.error, 'No data for this date')
})

test('get_stock_history', async () => {
  const r = await call('get_stock_history', { code: '900001', days: 3 })
  assertEquals(r.종목명, '돌파전자')
  assertEquals(r.rows.map((x: Json) => x.일자), [LIVE_DAY, DAY, '2026-11-12'])
  assertEquals(r.rows[1].종가, 11000)
  assert(r.charts.네이버_종목페이지)
})

test('screen_stocks: filters reach SQL, 억원 converted both ways', async () => {
  const spike = await call('screen_stocks', { date: DAY, min_trdval_ratio: 3 })
  assertEquals(spike.count, 1)
  assertEquals(spike.data_status, '확정치 (KRX official)')
  const s = spike.stocks[0]
  assertEquals([s.code, s.name, s.trdval_eok, s.trdval_avg_eok, s.trdval_ratio], ['900002', '급증바이오', 500, 100, 5])
  assertEquals(spike.filters.min_trdval_ratio, 3)

  // 550억 → 55,000,000,000원 in SQL: 대형강세 (600억) passes, 급증바이오 (500억) doesn't
  const big = await call('screen_stocks', { date: DAY, min_trdval_eok: 550 })
  assertEquals(big.stocks.map((x: Json) => x.code), ['900009'])
  const both = await call('screen_stocks', { date: DAY, min_trdval_eok: 500 })
  assertEquals(both.stocks.map((x: Json) => x.code).sort(), ['900002', '900009']) // >= is inclusive
})

test('screen_stocks: 60/120-day fields only when asked for', async () => {
  const plain = await call('screen_stocks', { date: DAY, breakout_days: [20] })
  assert(!('breakout_120' in plain.stocks[0]))
  assertEquals(plain.notes.length, 2)
  const long = await call('screen_stocks', { date: DAY, breakout_days: [120] })
  assertEquals(long.stocks.map((x: Json) => x.code).sort(), ['900001', '900005', '900008', '900009'])
  assertEquals(long.stocks[0].breakout_120, true)
})

test('screen_stocks: a weekend says so', async () => {
  const r = await call('screen_stocks', { date: '20261114' })
  assertEquals(r.date, '2026-11-14')
  assertStringIncludes(r.error, 'No data for this date')
})

test('screen_stocks: inconsistent box windows get a clear error', async () => {
  const r = await call('screen_stocks', { date: DAY, sideways_days: 5, sideways_recent_days: 5 })
  assertEquals(r.error, 'sideways_recent_days must be smaller than sideways_days.')
})

test('analyze_stock: by name, past date, no live quote', async () => {
  const r = await call('analyze_stock', { stock: '돌파전자', date: DAY })
  assertEquals([r.code, r.date, r.data_status], ['900001', DAY, '확정치 (KRX official)'])
  const codes = r.signals.map((s: Json) => s.code)
  for (const c of ['BREAKOUT_20D', 'BREAKOUT_60D', 'BREAKOUT_120D']) assert(codes.includes(c), `${c} in ${codes}`)
  assert(!('live_quote' in r) && !('live_quote_error' in r))
})

test('analyze_stock / screen_stocks: latest day is the provisional snapshot', async () => {
  // analyze reads the status from the provisional days, since it learns the day only from the history
  const a = await call('analyze_stock', { stock: '900001' })
  assertEquals([a.date, a.data_status, a.as_of], [LIVE_DAY, '장중 (intraday, provisional)', '2026-11-16 11:00 KST'])
  // a past day that still has a stale live_prices row is final (KRX replaced it)
  assertEquals((await call('analyze_stock', { stock: '900001', date: DAY })).data_status, '확정치 (KRX official)')
  const s = await call('screen_stocks', {})
  assertEquals([s.date, s.data_status], [LIVE_DAY, '장중 (intraday, provisional)'])
})

test('analyze_stock: new listing gets SHORT_HISTORY', async () => {
  const r = await call('analyze_stock', { stock: '900006', date: DAY })
  assertEquals(r.history_days, 10)
  assert(r.signals.some((s: Json) => s.code === 'SHORT_HISTORY'))
})

test('analyze_stock: non-trading date falls back with a note', async () => {
  const r = await call('analyze_stock', { stock: '900001', date: '2026-11-14' })
  assertEquals(r.note, `No row on 2026-11-14; using ${DAY}.`)
})

test('analyze_stock: unknown and ambiguous names', async () => {
  assertEquals((await call('analyze_stock', { stock: '없는종목', date: DAY })).error, 'No stock found.')
  const amb = await call('analyze_stock', { stock: '상', date: DAY }) // 상승제약, 신규상장
  assertEquals(amb.error, 'Ambiguous name; pass a 종목코드.')
  assertEquals(amb.candidates.map((c: Json) => c.isu_cd).sort(), ['900005', '900006'])
})

test('find_stock', async () => {
  assertEquals(await call('find_stock', { name: '바이오' }), [{ isu_cd: '900002', isu_nm: '급증바이오', market: 'KOSDAQ' }])
  assertEquals(await call('find_stock', { name: '없는종목' }), [])
})

test('check_available_dates: range, a final day, a missing day', async () => {
  const all = await call('check_available_dates')
  assertEquals([all.total_days, all.first, all.last], [142, '2026-05-01', LIVE_DAY]) // 141 KRX days + the live day
  assertEquals(all.data_status, '장중 (intraday, provisional)')

  const hit = await call('check_available_dates', { date: DAY })
  assertEquals([hit.available, hit.stocks, hit.data_status], [true, 12, '확정치 (KRX official)'])

  const miss = await call('check_available_dates', { date: '2026-11-14' })
  assertEquals([miss.available, miss.previous_trading_day, miss.next_trading_day], [false, DAY, LIVE_DAY])
})

test('invalid arguments are rejected by the schema, not crashed on', async () => {
  const r = await (await keyClient()).callTool({ name: 'get_stock_history', arguments: { code: '900001', days: 0 } })
  assert(r.isError, 'days: 0 should fail validation')
})

// ---- telegram tools -------------------------------------------------------------------------------

test('list_telegram_channels', async () => {
  const r = await call('list_telegram_channels')
  assertEquals(r.map((c: Json) => [c.channel, c.posts]).sort(), [['testchannel_a', 2], ['testchannel_b', 1]])
  assertEquals(r.find((c: Json) => c.channel === 'testchannel_a').link, 'https://t.me/testchannel_a')
})

test('get_telegram_feed: all channels, by channel, by stock', async () => {
  const all = await call('get_telegram_feed', { all_channels: true, since: '2026-11-01' })
  assertEquals(all.count, 3)
  const p = all.posts[0] // newest first
  assertEquals([p.channel, p.link, p.time], ['testchannel_a', 'https://t.me/testchannel_a/2', '2026-11-13 11:00 KST'])
  assertEquals(p.stocks, [{ code: '900002', name: '급증바이오' }])

  const b = await call('get_telegram_feed', { channel: '@testchannel_b', since: '2026-11-01' })
  assertEquals([b.scope, b.count], ['testchannel_b', 1])

  const stock = await call('get_telegram_feed', { all_channels: true, stock: '돌파전자', since: '2026-11-01' })
  assertEquals(stock.posts.map((x: Json) => x.link), ['https://t.me/testchannel_a/1'])
})

test('get_telegram_feed: bad, uncollected and unknown inputs explain themselves', async () => {
  assertStringIncludes((await call('get_telegram_feed', { channel: 'bad-name' })).error, 'Not a valid Telegram channel name')
  assertStringIncludes((await call('get_telegram_feed', { channel: 'notcollected' })).error, "isn't collected yet")
  assertStringIncludes((await call('get_telegram_feed', { stock: '없는종목' })).error, 'Unknown stock')
})

test('search_telegram: every word must match', async () => {
  const hbm = await call('search_telegram', { query: 'HBM', since: '2026-11-01' })
  assertEquals(hbm.count, 2)
  const both = await call('search_telegram', { query: 'HBM 수주', since: '2026-11-01' })
  assertEquals(both.posts.map((x: Json) => x.link), ['https://t.me/testchannel_a/1'])
  assertStringIncludes(both.posts[0].text, 'HBM')
})

// Extra posts for the fairness tests (msg_id 1000+), removed afterwards
async function withExtraPosts(rows: { username: string; msg_id: number; ts: string }[], fn: () => Promise<void>) {
  const { error } = await admin.from('telegram_messages').insert(rows.map((r) => ({ ...r, text: `extra ${r.msg_id}` })))
  if (error) throw new Error(error.message)
  try {
    await fn()
  } finally {
    await admin.from('telegram_messages').delete().gte('msg_id', 1000)
  }
}

test('get_telegram_feed: slots are shared across channels, so a busy one cannot crowd out the rest', async () => {
  const busy = [1, 2, 3, 4, 5].map((i) => ({ username: 'testchannel_a', msg_id: 1000 + i, ts: `2026-11-14T0${i}:00:00Z` }))
  await withExtraPosts(busy, async () => {
    const r = await call('get_telegram_feed', { all_channels: true, since: '2026-11-01', limit: 3 })
    // newest of each channel first (a/1005, b/1), then a's next; shown newest first
    assertEquals(r.posts.map((p: Json) => p.link), [
      'https://t.me/testchannel_a/1005', 'https://t.me/testchannel_a/1004', 'https://t.me/testchannel_b/1',
    ])
    assertEquals(r.channels.map((c: Json) => [c.channel, c.shown, c.in_window]), [['testchannel_a', 2, 7], ['testchannel_b', 1, 1]])
    assertStringIncludes(r.channels_note, 'testchannel_a has more posts')

    // One channel: just its newest posts, no note
    const one = await call('get_telegram_feed', { channel: 'testchannel_a', since: '2026-11-01', limit: 3 })
    assertEquals(one.posts.map((p: Json) => p.link.split('/').pop()), ['1005', '1004', '1003'])
    assertEquals(one.channels_note, undefined)
  })
})

test("get_telegram_feed: the default window shares today's posts first", async () => {
  // seconds ago, so "today" holds except in the first seconds after midnight KST
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
  const today = [1, 2, 3, 4].map((i) => ({ username: 'testchannel_a', msg_id: 1010 + i, ts: ago(i) }))
  const yesterday = [{ username: 'testchannel_b', msg_id: 1020, ts: ago(25 * 3600) }] // before midnight KST, in 3 days
  await withExtraPosts([...today, ...yesterday], async () => {
    const r = await call('get_telegram_feed', { all_channels: true, limit: 3 })
    assertEquals(r.posts.map((p: Json) => p.link.split('/').pop()), ['1011', '1012', '1013'])
    assertEquals(r.channels.map((c: Json) => [c.channel, c.shown, c.shown_today, c.today, c.in_window]), [['testchannel_a', 3, 3, 4, 4]])

    // A slot left after today's posts goes to earlier days
    const more = await call('get_telegram_feed', { all_channels: true, limit: 5 })
    assertEquals(more.posts.map((p: Json) => p.link.split('/').pop()), ['1011', '1012', '1013', '1014', '1020'])

    // An explicit since spreads the slots over the whole period instead
    const spread = await call('get_telegram_feed', { all_channels: true, since: ago(3 * 86400), limit: 3 })
    assertEquals(spread.posts.map((p: Json) => p.link.split('/').pop()), ['1011', '1012', '1020'])
  })
})

test('feed and search say when a channel is still filling, only if the window needs older posts', async () => {
  // testchannel_b as if just added: posts from 11-12 00:00 UTC stored, older ones still being collected
  const pending = { backfill_before: 1, backfill_oldest_ts: '2026-11-12T00:00:00Z', backfill_since: '2026-10-13T00:00:00Z' }
  const { error } = await admin.from('telegram_channels').update(pending).eq('username', 'testchannel_b')
  if (error) throw new Error(error.message)
  try {
    const feed = await call('get_telegram_feed', { all_channels: true, since: '2026-11-01' })
    assertEquals(feed.still_collecting, [{ channel: 'testchannel_b', collected_from: '2026-11-12 09:00 KST' }])
    assertStringIncludes(feed.still_collecting_note, 'still being collected')
    assertEquals(feed.count, 3) // the stored posts are still returned

    // A window inside what's stored, or another channel: no note
    assertEquals((await call('get_telegram_feed', { all_channels: true, since: '2026-11-13' })).still_collecting, undefined)
    assertEquals((await call('get_telegram_feed', { channel: 'testchannel_a', since: '2026-11-01' })).still_collecting, undefined)

    const one = await call('get_telegram_feed', { channel: 'testchannel_b', since: '2026-11-01' })
    assertEquals(one.still_collecting?.map((c: Json) => c.channel), ['testchannel_b'])

    const search = await call('search_telegram', { query: 'HBM', since: '2026-11-01' })
    assertEquals(search.still_collecting?.map((c: Json) => c.channel), ['testchannel_b'])
    assertEquals((await call('search_telegram', { query: 'HBM', channel: 'testchannel_a', since: '2026-11-01' })).still_collecting, undefined)

    const list = await call('list_telegram_channels')
    assertEquals(list.find((c: Json) => c.channel === 'testchannel_b').collecting_older_posts, true)
    assertEquals(list.find((c: Json) => c.channel === 'testchannel_a').collecting_older_posts, undefined)
  } finally {
    await admin.from('telegram_channels')
      .update({ backfill_before: null, backfill_oldest_ts: null, backfill_since: null }).eq('username', 'testchannel_b')
  }
})

test('add_telegram_channel: invalid name is refused without fetching', async () => {
  assertStringIncludes((await call('add_telegram_channel', { channel: 'bad-name' })).error, 'Not a valid Telegram channel name')
})

test('channel preferences need a logged-in user', async () => {
  for (const [tool, args] of [['get_my_channels', {}], ['set_my_channels', { channels: [] }], ['update_my_channels', {}]] as const) {
    assertStringIncludes((await call(tool, args)).error, 'logged-in user', tool)
  }
})

test('channel preferences: set, update, feed scope', async () => {
  const { token } = await testUser()
  const me = await connect({ token })
  const names = (r: Json) => r.channels.map((c: Json) => c.channel).sort()
  try {
    assertEquals((await call('set_my_channels', { channels: [] }, me)).channels, [])

    const set = await call('set_my_channels', { channels: ['t.me/testchannel_a', 'bad-name'] }, me)
    assertEquals(names(set), ['testchannel_a'])
    assertEquals(set.not_added, [{ channel: 'bad-name', error: 'not a valid Telegram channel name' }])

    const feed = await call('get_telegram_feed', { since: '2026-11-01' }, me)
    assertEquals([feed.scope, feed.count], ['your channels (1)', 2])

    const upd = await call('update_my_channels', { add: ['@testchannel_b'], remove: ['testchannel_a'] }, me)
    assertEquals(names(upd), ['testchannel_b'])
    assertEquals([upd.followed, upd.unfollowed], [['testchannel_b'], ['testchannel_a']])

    assertEquals(names(await call('get_my_channels', {}, me)), ['testchannel_b'])
  } finally {
    await call('set_my_channels', { channels: [] }, me)
    await me.close()
  }
})

// ---- usage logging --------------------------------------------------------------------------------

test('every call is logged to tool_calls (shared key and OAuth)', async () => {
  const marker = `logcheck-${crypto.randomUUID()}`
  await call('find_stock', { name: marker })
  const row = await waitForLog((q) => q.eq('tool', 'find_stock').eq('args->>name', marker))
  assertEquals([row.auth, row.user_id, row.ok, row.error], ['shared_key', null, true, null])
  assert(typeof row.latency_ms === 'number' && row.response_bytes === 2) // "[]"

  const { token, id } = await testUser()
  const me = await connect({ token })
  const marker2 = `logcheck-${crypto.randomUUID()}`
  await call('find_stock', { name: marker2 }, me)
  await me.close()
  const row2 = await waitForLog((q) => q.eq('args->>name', marker2))
  assertEquals([row2.auth, row2.user_id], ['oauth', id])
})

test('benchmark calls (shared key + krx-bench/ User-Agent) get _meta.latency_ms and are not logged', async () => {
  const bench = await connect({ key: KEY }, 'krx-bench/test-run')
  const marker = `benchcheck-${crypto.randomUUID()}`
  const r = await bench.callTool({ name: 'find_stock', arguments: { name: marker } }) as { _meta?: { latency_ms?: unknown } }
  await bench.close()
  assert(typeof r._meta?.latency_ms === 'number', `no _meta.latency_ms: ${JSON.stringify(r._meta)}`)
  // A normal call made after it is logged; by then the benchmark call's row would be there too, if it were written
  const after = `logcheck-${crypto.randomUUID()}`
  await call('find_stock', { name: after })
  await waitForLog((q) => q.eq('args->>name', after))
  const { data } = await admin.from('tool_calls').select('id').eq('args->>name', marker)
  assertEquals(data, [])
})

test('normal calls carry no _meta', async () => {
  const r = await (await keyClient()).callTool({ name: 'find_stock', arguments: { name: '바이오' } }) as { _meta?: unknown }
  assertEquals(r._meta, undefined)
})

test('a logged-in user with a krx-bench/ User-Agent is still logged', async () => {
  const { token, id } = await testUser()
  const me = await connect({ token }, 'krx-bench/spoof')
  const marker = `logcheck-${crypto.randomUUID()}`
  const r = await me.callTool({ name: 'find_stock', arguments: { name: marker } }) as { _meta?: unknown }
  await me.close()
  assertEquals(r._meta, undefined)
  const row = await waitForLog((q) => q.eq('args->>name', marker))
  assertEquals([row.auth, row.user_id, row.client], ['oauth', id, 'krx-bench/spoof'])
})

test('logged calls carry per-step timings', async () => {
  const { token, id } = await testUser()
  const me = await connect({ token })
  try {
    await call('set_my_channels', { channels: ['testchannel_a'] }, me)
    const marker = `2026-11-0${1 + Math.floor(Math.random() * 9)}T00:00:00.${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}Z`
    await call('get_telegram_feed', { since: marker }, me)
    const row = await waitForLog((q) => q.eq('tool', 'get_telegram_feed').eq('user_id', id).eq('args->>since', marker))
    const steps = (row.timings as { step: string; start: number; ms: number }[]).map((s) => s.step)
    // the user's channels, then their posts, then 종목명 for the tagged codes
    for (const s of ['user_channels', 'messages', 'stock_names']) assert(steps.includes(s), `${s} in ${steps}`)
    assert(steps.indexOf('user_channels') < steps.indexOf('messages'))
    for (const t of row.timings) assert(Number.isInteger(t.start) && Number.isInteger(t.ms) && t.ms >= 0, JSON.stringify(t))
  } finally {
    await call('set_my_channels', { channels: [] }, me)
    await me.close()
  }
})

test('parallel steps show as overlapping (check_available_dates)', async () => {
  const bench = await connect({ key: KEY }, 'krx-bench/test-run')
  const r = await bench.callTool({ name: 'check_available_dates', arguments: {} }) as { _meta?: { timings?: { step: string; start: number }[] } }
  await bench.close()
  const t = r._meta?.timings ?? []
  const names = t.map((s) => s.step)
  for (const s of ['dates_count', 'dates_first', 'dates_last']) assert(names.includes(s), `${s} in ${names}`)
  assert(!names.includes('data_status'), `the status comes with the last day's row: ${names}`)
  const starts = t.filter((s) => s.step.startsWith('dates_')).map((s) => s.start)
  assert(Math.max(...starts) - Math.min(...starts) < 20, `the three date queries start together: ${starts}`)
})

// Each removed round trip is ~40–50 ms in production; these pin which queries wait for which
test('fewer sequential queries: movers, screen, analyze, search', async () => {
  const bench = await connect({ key: KEY }, 'krx-bench/test-run')
  const steps = async (name: string, args: Json) => {
    const r = await bench.callTool({ name, arguments: args }) as { _meta?: { timings?: { step: string; start: number }[] } }
    return r._meta?.timings ?? []
  }
  const together = (t: { step: string; start: number }[], a: string, b: string) => {
    const [x, y] = [t.find((s) => s.step === a), t.find((s) => s.step === b)]
    assert(x && y, `${a} and ${b} in ${t.map((s) => s.step)}`)
    assert(Math.abs(x.start - y.start) < 20, `${a} and ${b} start together: ${JSON.stringify(t)}`)
  }
  try {
    // latest day: its row carries the status, so no data_status query
    for (const tool of ['get_daily_movers', 'screen_stocks']) {
      const names = (await steps(tool, {})).map((s) => s.step)
      assert(names.includes('latest_date') && !names.includes('data_status'), `${tool}: ${names}`)
    }
    // a given date: the status row is fetched alongside the main query
    together(await steps('get_daily_movers', { date: DAY }), 'data_status', 'movers')
    together(await steps('screen_stocks', { date: DAY }), 'data_status', 'screen_stocks_rpc')
    together(await steps('analyze_stock', { stock: '900001' }), 'history', 'provisional_days')
    // the trading day is cached per instance for 5 minutes, so it may not be queried at all
    const search = await steps('search_telegram', { query: '돌파전자', since: '2026-01-01' })
    if (search.some((s) => s.step === 'latest_trading_day')) together(search, 'search', 'latest_trading_day')
  } finally {
    await bench.close()
  }
})

// Region forwarding can't run locally (DB_REGION unset), so this sends what a landing copy would add
test('forwarded calls log the hop (landed_in, forward_ms); direct calls log none', async () => {
  const marker = `hop-${crypto.randomUUID()}`
  // The stamp is fixed when the client is created, so the measured hop includes the MCP handshake: only bounds checked
  const hop = await connect({ key: KEY }, undefined, {
    'x-mcp-forwarded': '1',
    'x-mcp-landed-at': String(Date.now() - 150),
    'x-mcp-landed-in': 'test-landing-region',
    'x-mcp-client': 'Claude-User', // the User-Agent the landing copy saw
    'x-mcp-forward-ms': '1', // a caller's own value must be ignored
  })
  try {
    await call('find_stock', { name: marker }, hop)
  } finally {
    await hop.close()
  }
  const row = await waitForLog((q) => q.eq('tool', 'find_stock').eq('args->>name', marker))
  assertEquals(row.landed_in, 'test-landing-region')
  assert(row.forward_ms >= 150 && row.forward_ms < 30_000, `forward_ms ${row.forward_ms}`)
  assertEquals(row.handled_in, null) // SB_REGION is unset locally
  assertEquals(row.client, 'Claude-User') // not this request's own User-Agent, which the runtime would have altered

  // A direct call can't put values in the log
  const direct = `hop-${crypto.randomUUID()}`
  const spoof = await connect({ key: KEY }, 'krx-mcp-tests/direct', {
    'x-mcp-forward-ms': '5',
    'x-mcp-landed-in': 'fake',
    'x-mcp-client': 'fake',
  })
  try {
    await call('find_stock', { name: direct }, spoof)
  } finally {
    await spoof.close()
  }
  const d = await waitForLog((q) => q.eq('tool', 'find_stock').eq('args->>name', direct))
  assertEquals([d.landed_in, d.forward_ms, d.client], [null, null, 'krx-mcp-tests/direct'])
})

// Close the shared client last so its stream doesn't outlive the tests
test('cleanup', async () => {
  await shared?.close()
})
