// Benchmark of the read-only MCP tools against the deployed function (production data volume; the local seed is too
// small to time anything). For each call it records:
//   total     client wall time of the tools/call request (what a user waits for, minus the LLM)
//   tool      server-side latency_ms, returned in the result's _meta (the tool handler only, as in tool_calls)
//   overhead  total - tool (network, gateway, auth, MCP request handling)
//
//   deno task bench                                  # 50 calls per case: 5 rounds of 10, 60 s apart, after 1 warm-up
//   deno task bench -- --n 20 --rounds 2 --pause 10
//   deno task bench -- --only get_telegram_feed
//
// Uses the shared ?key= URL (MCP_ACCESS_KEY from supabase/.env, never printed) with the User-Agent krx-bench/<run id>.
// The server recognizes that pair: it returns latency_ms in _meta and does not log the call, so tool_calls stays
// real usage only. Results go to bench-results/<run id>.json (gitignored).
//
// Arguments mirror real usage (tool_calls.args): no date where real calls omit it (so the latest day, live during the
// session, and analyze_stock's live KIS quote), Telegram reads with short `since` windows. Not covered: the write tools
// (add_telegram_channel, set_/update_my_channels) and anything per-user (get_my_channels; the feed of a user's own
// channels): the shared key has no user, so get_telegram_feed reads all channels.

import { Client, StreamableHTTPClientTransport } from 'npm:@modelcontextprotocol/client@2.4.0'

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

// args are built per call, so relative windows (since = 1 hour ago) stay relative
const CASES: { label: string; tool: string; args: () => Record<string, unknown> }[] = [
  // Telegram: most real calls (an hourly scheduled feed, plus searches for a name over the last few days)
  { label: 'get_telegram_feed (1h, 30)', tool: 'get_telegram_feed', args: () => ({ since: hoursAgo(1), limit: 30 }) },
  { label: 'get_telegram_feed (20h, 50)', tool: 'get_telegram_feed', args: () => ({ since: hoursAgo(20), limit: 50 }) },
  { label: 'search_telegram (60h, 10)', tool: 'search_telegram', args: () => ({ query: '삼성전자', since: hoursAgo(60), limit: 10 }) },
  { label: 'list_telegram_channels', tool: 'list_telegram_channels', args: () => ({}) },
  // Market data, latest day, as real calls ask
  { label: 'get_daily_movers (latest)', tool: 'get_daily_movers', args: () => ({}) },
  { label: 'check_available_dates', tool: 'check_available_dates', args: () => ({}) },
  { label: 'analyze_stock (latest)', tool: 'analyze_stock', args: () => ({ stock: '005930' }) },
  { label: 'get_stock_history (20d)', tool: 'get_stock_history', args: () => ({ code: '005930', days: 20 }) },
  // Not used in real calls yet; kept so a regression shows up
  { label: 'screen_stocks (spike) *', tool: 'screen_stocks', args: () => ({ min_trdval_ratio: 3 }) },
  { label: 'find_stock *', tool: 'find_stock', args: () => ({ name: '삼성' }) },
]

function flag(name: string, fallback: number): number {
  const i = Deno.args.indexOf(`--${name}`)
  return i >= 0 && Deno.args[i + 1] ? Number(Deno.args[i + 1]) : fallback
}
const N = flag('n', 50)
const ROUNDS = Math.max(1, Math.min(N, flag('rounds', 5)))
const PAUSE_S = flag('pause', 60)
const onlyAt = Deno.args.indexOf('--only')
const ONLY = onlyAt >= 0 ? Deno.args[onlyAt + 1] : ''

function env(name: string): string {
  const text = Deno.readTextFileSync(new URL('../supabase/.env', import.meta.url))
  const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm'))
  if (!m) throw new Error(`${name} is missing from supabase/.env`)
  return m[1].replace(/^["']|["']$/g, '')
}
const REF = Deno.readTextFileSync(new URL('../supabase/.temp/project-ref', import.meta.url)).trim()
const MCP = `https://${REF}.supabase.co/functions/v1/mcp`
const RUN = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'

// ---- calls ----------------------------------------------------------------------------------------

type TimedStep = { step: string; start: number; ms: number }
type Call = {
  label: string
  round: number
  warmup: boolean
  total_ms: number
  tool_ms: number | null
  steps: TimedStep[]
  bytes: number
  error?: string
}

const url = new URL(MCP)
url.searchParams.set('key', env('MCP_ACCESS_KEY'))
const client = new Client({ name: 'krx-bench', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'User-Agent': `krx-bench/${RUN}` } } }))

const cases = CASES.filter((c) => !ONLY || c.tool === ONLY)
const calls: Call[] = []

async function one(c: (typeof CASES)[number], round: number, warmup: boolean) {
  const t0 = performance.now()
  let bytes = 0, toolMs: number | null = null, steps: TimedStep[] = [], error: string | undefined
  try {
    const r = await client.callTool({ name: c.tool, arguments: c.args() }) as {
      isError?: boolean
      content: { text?: string }[]
      _meta?: { latency_ms?: number; timings?: TimedStep[] }
    }
    bytes = r.content.reduce((n, x) => n + (x.text?.length ?? 0), 0)
    toolMs = r._meta?.latency_ms ?? null
    steps = r._meta?.timings ?? []
    if (r.isError) error = r.content[0]?.text?.slice(0, 200)
  } catch (e) {
    error = (e as Error).message
  }
  calls.push({ label: c.label, round, warmup, total_ms: performance.now() - t0, tool_ms: toolMs, steps, bytes, error })
}

const perRound = Array.from({ length: ROUNDS }, (_, r) => Math.floor(N / ROUNDS) + (r < N % ROUNDS ? 1 : 0))
console.log(`run ${RUN}: ${cases.length} cases × ${N} calls (${ROUNDS} rounds, ${PAUSE_S}s apart) + 1 warm-up each`)
for (const c of cases) {
  await one(c, 0, true)
  // A deployed function without the benchmark change neither returns _meta nor skips logging: stop after one call
  // instead of writing hundreds of rows into tool_calls
  const first = calls[calls.length - 1]
  if (calls.length === 1 && first.tool_ms == null && !first.error) {
    await client.close()
    console.error(
      'The deployed mcp function returned no _meta.latency_ms, so it would log every benchmark call.\n' +
        'Deploy it first (supabase functions deploy mcp). This one call was logged; delete it with:\n' +
        `  delete from tool_calls where client = 'krx-bench/${RUN}';`,
    )
    Deno.exit(1)
  }
}
for (let r = 0; r < ROUNDS; r++) {
  if (r > 0) await new Promise((res) => setTimeout(res, PAUSE_S * 1000))
  for (const c of cases) for (let i = 0; i < perRound[r]; i++) await one(c, r + 1, false)
  console.log(`  round ${r + 1}/${ROUNDS} done`)
}
await client.close()

if (calls.some((c) => !c.warmup && c.tool_ms == null && !c.error)) {
  console.warn('\nno _meta.latency_ms in some results: is the deployed mcp function older than the benchmark change?')
}

// ---- report ---------------------------------------------------------------------------------------

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] // nearest rank
}
const report = cases.map((c) => {
  const xs = calls.filter((x) => x.label === c.label && !x.warmup && !x.error)
  const total = xs.map((x) => x.total_ms)
  const tool = xs.filter((x) => x.tool_ms != null).map((x) => x.tool_ms!)
  const overhead = xs.filter((x) => x.tool_ms != null).map((x) => x.total_ms - x.tool_ms!)
  const warm = calls.find((x) => x.label === c.label && x.warmup)!
  return {
    label: c.label,
    n: xs.length,
    errors: calls.filter((x) => x.label === c.label && x.error).length,
    kb: xs.length ? Math.round(xs[0].bytes / 1024) : 0,
    warmup: { total: warm.total_ms, tool: warm.tool_ms },
    total: { p50: q(total, 50), p95: q(total, 95), max: Math.max(...total) },
    tool: { p50: q(tool, 50), p95: q(tool, 95) },
    overhead: { p50: q(overhead, 50), p95: q(overhead, 95) },
  }
})

const ms = (x: number | null) => (x == null || Number.isNaN(x) ? '—' : String(Math.round(x)))
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length))
const lpad = (s: string, n: number) => ' '.repeat(Math.max(0, n - s.length)) + s
const cols = ['n', 'err', 'KB', 'warm-up', 'total p50', 'p95', 'max', 'tool p50', 'p95', 'ovh p50', 'p95']
console.log('\n' + pad('case', 30) + cols.map((h, i) => lpad(h, i < 3 ? 4 : 10)).join(''))
for (const r of report) {
  console.log(
    pad(r.label, 30) + [r.n, r.errors, r.kb].map((v) => lpad(String(v), 4)).join('') +
      [r.warmup.total, r.total.p50, r.total.p95, r.total.max, r.tool.p50, r.tool.p95, r.overhead.p50, r.overhead.p95]
        .map((v) => lpad(ms(v), 10)).join(''),
  )
}
console.log('* not used in real calls yet')

// Where the tool time goes: median duration and start of each step, per case (bg_ = background work, not waited on)
console.log('\nsteps (p50 ms, p50 start):')
for (const c of cases) {
  const xs = calls.filter((x) => x.label === c.label && !x.warmup && !x.error)
  const names = [...new Set(xs.flatMap((x) => x.steps.map((s) => s.step)))]
  const parts = names.map((n) => {
    const ss = xs.flatMap((x) => x.steps.filter((s) => s.step === n))
    return `${n} ${ms(q(ss.map((s) => s.ms), 50))} @${ms(q(ss.map((s) => s.start), 50))}`
  })
  console.log(`  ${pad(c.label, 30)}${parts.join(' → ') || '(no steps)'}`)
}
const errs = calls.filter((c) => c.error)
if (errs.length) console.log('\nerrors:\n  ' + errs.slice(0, 5).map((e) => `${e.label}: ${e.error}`).join('\n  '))

await Deno.mkdir(new URL('../bench-results/', import.meta.url), { recursive: true })
await Deno.writeTextFile(
  new URL(`../bench-results/${RUN}.json`, import.meta.url),
  JSON.stringify({ run: RUN, target: MCP, n: N, rounds: ROUNDS, pause_s: PAUSE_S, report, calls }, null, 1),
)
console.log(`\nsaved bench-results/${RUN}.json`)
