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

async function connect(auth: { key: string } | { token: string }): Promise<Client> {
  const url = new URL(MCP)
  const headers: Record<string, string> = {}
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
  assertEquals([hit.available, hit.stocks, hit.data_status], [true, 9, '확정치 (KRX official)'])

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

// Close the shared client last so its stream doesn't outlive the tests
test('cleanup', async () => {
  await shared?.close()
})
