// Shared by scripts/bench.ts (warm) and scripts/bench_cold.ts (cold): the cases, arguments, the MCP client and one
// timed call, and the number formatting.
//
// Both use the shared ?key= URL (MCP_ACCESS_KEY from supabase/.env, never printed) with the User-Agent
// krx-bench/<run id>. The server recognizes that pair: it returns latency_ms, timings and the hop in _meta and does not
// log the call, so tool_calls stays real usage only.
//
// Arguments mirror real usage (tool_calls.args): no date where real calls omit it (so the latest day, live during the
// session, and analyze_stock's live KIS quote), Telegram reads with short `since` windows. Not covered: the write tools
// (add_telegram_channel, set_/update_my_channels) and anything per-user (get_my_channels; the feed of a user's own
// channels): the shared key has no user, so get_telegram_feed reads all channels.

import { Client, StreamableHTTPClientTransport } from 'npm:@modelcontextprotocol/client@2.4.0'

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

export type Case = { label: string; tool: string; args: () => Record<string, unknown> }

// args are built per call, so relative windows (since = 1 hour ago) stay relative
export const CASES: Case[] = [
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

export function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`)
  return i >= 0 ? Deno.args[i + 1] : undefined
}

export function region(fallback = ''): string {
  const r = arg('region') ?? fallback
  if (r && !/^[a-z]{2}-[a-z]+-\d$/.test(r)) {
    console.error(`--region: not a region name (e.g. us-east-1): ${r}`)
    Deno.exit(1)
  }
  return r
}

function env(name: string): string {
  const text = Deno.readTextFileSync(new URL('../supabase/.env', import.meta.url))
  const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm'))
  if (!m) throw new Error(`${name} is missing from supabase/.env`)
  return m[1].replace(/^["']|["']$/g, '')
}
const REF = Deno.readTextFileSync(new URL('../supabase/.temp/project-ref', import.meta.url)).trim()
export const MCP = `https://${REF}.supabase.co/functions/v1/mcp`
export const RUN = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'

// ---- calls ----------------------------------------------------------------------------------------

export type TimedStep = { step: string; start: number; ms: number }
type Meta = {
  latency_ms?: number
  timings?: TimedStep[]
  hop?: { landedIn?: string | null; forwardMs?: number | null; handledIn?: string | null }
}
export type Call = {
  label: string
  at: string // start time, ISO
  total_ms: number
  tool_ms: number | null
  forward_ms: number | null
  landed_in: string | null
  handled_in: string | null
  steps: TimedStep[]
  bytes: number
  error?: string
}

/** An MCP client on the benchmark URL. `region`: Supabase's x-region header (land there, be forwarded from there). */
export async function connect(region: string): Promise<Client> {
  const url = new URL(MCP)
  url.searchParams.set('key', env('MCP_ACCESS_KEY'))
  const headers: Record<string, string> = { 'User-Agent': `krx-bench/${RUN}` }
  if (region) headers['x-region'] = region
  const client = new Client({ name: 'krx-bench', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }))
  return client
}

/** One timed tools/call. Never throws: a failure is the call's `error`. */
export async function callOnce(client: Client, c: Case): Promise<Call> {
  const at = new Date().toISOString()
  const t0 = performance.now()
  let bytes = 0, meta: Meta = {}, error: string | undefined
  try {
    const r = await client.callTool({ name: c.tool, arguments: c.args() }) as {
      isError?: boolean
      content: { text?: string }[]
      _meta?: Meta
    }
    bytes = r.content.reduce((n, x) => n + (x.text?.length ?? 0), 0)
    meta = r._meta ?? {}
    if (r.isError) error = r.content[0]?.text?.slice(0, 200)
  } catch (e) {
    error = (e as Error).message
  }
  return {
    label: c.label,
    at,
    total_ms: performance.now() - t0,
    tool_ms: meta.latency_ms ?? null,
    forward_ms: meta.hop?.forwardMs ?? null,
    landed_in: meta.hop?.landedIn ?? meta.hop?.handledIn ?? null, // not forwarded: it landed where it ran
    handled_in: meta.hop?.handledIn ?? null,
    steps: meta.timings ?? [],
    bytes,
    error,
  }
}

/**
 * A deployed function without the benchmark change neither returns _meta nor skips logging: after the first call,
 * stop instead of writing hundreds of rows into tool_calls.
 */
export async function stopIfLogged(client: Client, first: Call) {
  if (first.tool_ms != null || first.error) return
  await client.close()
  console.error(
    'The deployed mcp function returned no _meta.latency_ms, so it would log every benchmark call.\n' +
      'Deploy it first (supabase functions deploy mcp). This one call was logged; delete it with:\n' +
      `  delete from tool_calls where client = 'krx-bench/${RUN}';`,
  )
  Deno.exit(1)
}

// ---- report helpers -------------------------------------------------------------------------------

export const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] // nearest rank
}
export const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x != null)
export const p5095 = (xs: number[]) => ({ p50: q(xs, 50), p95: q(xs, 95) })
export const ms = (x: number | null) => (x == null || Number.isNaN(x) ? '—' : String(Math.round(x)))
export const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length))
export const lpad = (s: string, n: number) => ' '.repeat(Math.max(0, n - s.length)) + s
export const regions = (calls: Call[], pick: (c: Call) => string | null) =>
  [...new Set(calls.filter((c) => !c.error).map(pick).filter(Boolean))].join(', ') || '—'

/** Median duration and start of each step, per case: where the tool time goes. */
export function printSteps(cases: Case[], calls: Call[]) {
  console.log('\nsteps (p50 ms, p50 start):')
  for (const c of cases) {
    const xs = calls.filter((x) => x.label === c.label && !x.error)
    const names = [...new Set(xs.flatMap((x) => x.steps.map((s) => s.step)))]
    const parts = names.map((n) => {
      const ss = xs.flatMap((x) => x.steps.filter((s) => s.step === n))
      return `${n} ${ms(q(ss.map((s) => s.ms), 50))} @${ms(q(ss.map((s) => s.start), 50))}`
    })
    console.log(`  ${pad(c.label, 30)}${parts.join(' → ') || '(no steps)'}`)
  }
}

export async function save(name: string, text: string) {
  await Deno.mkdir(new URL('../bench-results/', import.meta.url), { recursive: true })
  await Deno.writeTextFile(new URL(`../bench-results/${name}`, import.meta.url), text)
}
