// Telegram gate experiment (docs/plan.md → Phase 2), run locally: nothing is written to production.
// One Claude Haiku 5.5 call per post labels it (market / noise), tags the companies it mentions (KR code or US ticker)
// and the events it's about (ids from scripts/tg_gate_events.json). The guesses are checked against the KRX stock list
// and the Nasdaq + NYSE symbol list, and compared with the name matcher's tags (./name_matcher.ts, the tagger used
// before the gate).
//
//   deno task tg-gate export 14     # posts of the last 14 days + the KRX stock list, read-only from production
//   deno task tg-gate symbols       # Nasdaq's symbol files (Nasdaq + NYSE and other US exchanges)
//   deno task tg-gate run           # the gate over every exported post → experiments/tg-gate/<run>/
//   deno task tg-gate run --limit 50 --concurrency 8 --thinking
//   deno task tg-gate recheck 20261119T072034Z   # re-run the checks on a saved run, no model calls
//
// Data and results stay in experiments/ (gitignored: third-party posts, public repo). The Anthropic credentials come
// from the environment or an `ant auth login` profile. Posts with no text are labeled noise without a call.

import Anthropic from 'npm:@anthropic-ai/sdk@1.5.0'
import {
  askGate, checker, type Checked, type Company, GATE_MODEL, GATE_PRICE, GATE_VERSION, type GateEvent, type GatePost,
  listedName, parseSymbolFile, type Stock, SYMBOL_FILES, symbolFileUrl, type UsSymbol, writtenName,
} from '../supabase/functions/_shared/gate.ts'
import { buildStockIndex, tagStocks } from './name_matcher.ts'

// The gate itself (prompt, schema, checks, alias lists) is supabase/functions/_shared/gate.ts, shared with
// telegram-ingest; this script exports data, runs it over the export, and writes the report.
const DIR = new URL('../experiments/tg-gate/', import.meta.url)
const DATA = new URL('data/', DIR)
const EVENTS_FILE = new URL('./tg_gate_events.json', import.meta.url)

// ---- data -------------------------------------------------------------------------------------------

export type Post = GatePost

// Runs a read-only query on the linked project with the Supabase CLI and returns its rows
async function query<T>(sql: string): Promise<T[]> {
  const out = await new Deno.Command('supabase', { args: ['db', 'query', '--remote', '--read-only', sql], stderr: 'piped' }).output()
  const text = new TextDecoder().decode(out.stdout)
  if (!out.success) throw new Error(`supabase db query: ${new TextDecoder().decode(out.stderr).slice(0, 500)}`)
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  return json.rows as T[]
}

async function exportData(days: number) {
  await Deno.mkdir(DATA, { recursive: true })
  const posts = await query<Post>(
    `select username, msg_id, ts, text, has_media, forwarded_from from telegram_messages ` +
      `where ts > now() - interval '${Math.round(days)} days' order by ts`,
  )
  const stocks = await query<Stock>(
    `select isu_cd, isu_nm, market from prices where bas_dd = (select max(bas_dd) from daily_prices) order by isu_cd`,
  )
  await Deno.writeTextFile(new URL('posts.json', DATA), JSON.stringify(posts))
  await Deno.writeTextFile(new URL('stocks.json', DATA), JSON.stringify(stocks))
  console.log(`exported ${posts.length} posts (${days} days) and ${stocks.length} stocks to ${DATA.pathname}`)
}

// Nasdaq Trader's symbol directory (Nasdaq + NYSE and the other US exchanges)
async function exportSymbols() {
  await Deno.mkdir(DATA, { recursive: true })
  const symbols: UsSymbol[] = []
  for (const file of SYMBOL_FILES) {
    const res = await fetch(symbolFileUrl(file))
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
    symbols.push(...parseSymbolFile(file, await res.text()))
  }
  await Deno.writeTextFile(new URL('us_symbols.json', DATA), JSON.stringify(symbols))
  console.log(`saved ${symbols.length} US symbols (no ETFs, no test issues)`)
}

// ---- the gate over the export ---------------------------------------------------------------------

export type Result = {
  username: string
  msg_id: number
  ts: string
  text: string
  old_kr: string[]
  label: 'market' | 'noise'
  reason: 'empty' | 'model'
  companies: Company[]
  kr: string[]
  us: string[]
  usByName: string[]
  events: string[]
  rejected: Checked['rejected']
  usage?: { input: number; output: number }
  ms?: number
  error?: string
}

// old_kr: the name matcher's tags (the baseline), computed here: production no longer stores them
async function gate(client: Anthropic, p: Post, events: GateEvent[], check: ReturnType<typeof checker>, thinking: boolean, oldKr: string[]): Promise<Result> {
  const base = { username: p.username, msg_id: p.msg_id, ts: p.ts, text: p.text, old_kr: oldKr }
  const t0 = performance.now()
  try {
    const a = await askGate(client, p, events, { thinking })
    return { ...base, ...a, ...check(a.companies) }
  } catch (e) {
    // A failed call keeps the post (labeled market, untagged), as production does (there: ungated, retried)
    return {
      ...base, label: 'market', reason: 'model', companies: [], kr: [], us: [], usByName: [], events: [], rejected: [],
      ms: Math.round(performance.now() - t0), error: (e as Error).message,
    }
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0, done = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
      if (++done % 50 === 0) console.log(`  ${done}/${items.length}`)
    }
  }))
  return out
}

// ---- report -----------------------------------------------------------------------------------------

const clip = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const link = (r: Result) => `https://t.me/${r.username}/${r.msg_id}`
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–')

export function report(results: Result[], names: Map<string, string>, meta: Record<string, unknown>): string {
  const L: string[] = []
  const called = results.filter((r) => r.reason === 'model' && !r.error)
  const input = called.reduce((s, r) => s + (r.usage?.input ?? 0), 0)
  const output = called.reduce((s, r) => s + (r.usage?.output ?? 0), 0)
  const cost = (input * GATE_PRICE.input + output * GATE_PRICE.output) / 1e6
  const ms = called.map((r) => r.ms!).sort((a, b) => a - b)
  const errors = results.filter((r) => r.error)
  const days = Math.max(1, (Date.parse(results.at(-1)!.ts) - Date.parse(results[0].ts)) / 86400_000)

  L.push(`# Telegram gate experiment`, '')
  L.push(...Object.entries(meta).map(([k, v]) => `- ${k}: ${v}`))
  L.push(
    `- posts: ${results.length} over ${days.toFixed(1)} days; model calls: ${called.length}, failed: ${errors.length}`,
    `- tokens: ${input} in, ${output} out → $${cost.toFixed(4)} (${(cost / days * 30).toFixed(2)} $/month at this volume)`,
    `- call latency: p50 ${ms[Math.floor(ms.length / 2)] ?? '–'} ms, p95 ${ms[Math.floor(ms.length * 0.95)] ?? '–'} ms`,
    '',
  )

  L.push('## Labels per channel', '', '| channel | posts | market | noise (empty) | noise (model) |', '|---|---|---|---|---|')
  for (const ch of [...new Set(results.map((r) => r.username))]) {
    const rs = results.filter((r) => r.username === ch)
    const empty = rs.filter((r) => r.reason === 'empty').length
    const model = rs.filter((r) => r.label === 'noise' && r.reason === 'model').length
    L.push(`| ${ch} | ${rs.length} | ${rs.length - empty - model} | ${empty} | ${model} (${pct(model, rs.length - empty)}) |`)
  }

  L.push('', '## Posts the model labeled noise (review these)', '')
  for (const r of results.filter((r) => r.label === 'noise' && r.reason === 'model')) {
    L.push(`- ${r.username} — ${clip(r.text)} — ${link(r)}`)
  }

  // KR tags: the model's (checked) vs. the name-matching tagger's
  const kr = { both: 0, onlyNew: 0, onlyOld: 0 }
  const onlyNew = new Map<string, number>(), onlyOld = new Map<string, number>()
  const disagree: Result[] = []
  for (const r of called) {
    const a = new Set(r.old_kr), b = new Set(r.kr)
    for (const c of b) a.has(c) ? kr.both++ : (kr.onlyNew++, onlyNew.set(c, (onlyNew.get(c) ?? 0) + 1))
    for (const c of a) if (!b.has(c)) (kr.onlyOld++, onlyOld.set(c, (onlyOld.get(c) ?? 0) + 1))
    if (a.size !== b.size || [...a].some((c) => !b.has(c))) disagree.push(r)
  }
  const top = (m: Map<string, number>) =>
    [...m].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([c, n]) => `${names.get(c) ?? c} (${c}) ×${n}`).join(', ') || '–'
  L.push(
    '', '## KR stock tags: model vs. name matching', '',
    `Tags on posts the model saw: in both ${kr.both}, model only ${kr.onlyNew}, name matching only ${kr.onlyOld}. ` +
      `Posts where they differ: ${disagree.length} of ${called.length}.`,
    '', `- model only, most frequent: ${top(onlyNew)}`, `- name matching only, most frequent: ${top(onlyOld)}`,
    '', '### Examples where they differ', '',
  )
  for (const r of disagree.slice(0, 40)) {
    const fmt = (cs: string[]) => cs.map((c) => names.get(c) ?? c).join(', ') || '–'
    L.push(`- ${r.username} — ${clip(r.text, 100)} — model: ${fmt(r.kr)} / matching: ${fmt(r.old_kr)} — ${link(r)}`)
  }

  const us = new Map<string, number>()
  for (const r of called) for (const t of r.us) us.set(t, (us.get(t) ?? 0) + 1)
  L.push(
    '', '## US tickers', '',
    `${called.filter((r) => r.us.length).length} posts tagged with a US ticker; ${us.size} tickers.`, '',
    [...us].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t, n]) => `${t} ×${n}`).join(', ') || '–',
  )
  const byName = called.flatMap((r) => r.usByName.map((x) => `${x} — ${link(r)}`))
  L.push('', `Found by name (no ticker, an unlisted one, or one whose listed name didn't match): ${byName.length}`, '', ...byName.slice(0, 60).map((x) => `- ${x}`))

  L.push('', '## Events', '')
  const evIds = [...new Set(called.flatMap((r) => r.events))]
  if (!evIds.length) L.push('No post was tagged with an event.')
  for (const id of evIds) {
    const rs = called.filter((r) => r.events.includes(id))
    L.push(`### ${id} (${rs.length} posts)`, '', ...rs.slice(0, 30).map((r) => `- ${r.username} — ${clip(r.text)} — ${link(r)}`), '')
  }

  L.push('', '## Rejected guesses (the model named a company, the check refused it)', '')
  const rej = called.flatMap((r) => r.rejected.map((x) => ({ ...x, r })))
  L.push(`${rej.length} rejected.`, '')
  for (const x of rej.slice(0, 80)) {
    const w = writtenName(x), l = listedName(x)
    L.push(`- ${x.market} "${w}"${l && l !== w ? ` (listed: ${l})` : ''} → "${x.id}": ${x.why} — ${link(x.r)}`)
  }

  if (errors.length) {
    L.push('', '## Failed calls', '')
    for (const r of errors.slice(0, 20)) L.push(`- ${link(r)}: ${r.error}`)
  }
  return L.join('\n') + '\n'
}

// ---- main -------------------------------------------------------------------------------------------

const arg = (name: string) => {
  const i = Deno.args.indexOf(`--${name}`)
  return i >= 0 ? Deno.args[i + 1] : undefined
}

async function run() {
  const read = async <T>(f: string): Promise<T> => JSON.parse(await Deno.readTextFile(new URL(f, DATA)))
  let posts = await read<Post[]>('posts.json').catch(() => { throw new Error('no export: run `deno task tg-gate export` first') })
  const stocks = await read<Stock[]>('stocks.json')
  const symbols = await read<UsSymbol[]>('us_symbols.json').catch(() => {
    throw new Error('no US symbols: run `deno task tg-gate symbols` first')
  })
  const events = JSON.parse(await Deno.readTextFile(EVENTS_FILE)) as GateEvent[]
  const limit = Number(arg('limit') ?? 0)
  if (limit) posts = posts.slice(-limit) // the most recent ones
  const thinking = Deno.args.includes('--thinking')

  const client = new Anthropic()
  const check = checker(stocks, symbols)
  console.log(`gating ${posts.length} posts with ${GATE_MODEL} (${thinking ? 'thinking, effort low' : 'no thinking'}), ${events.length} events`)
  const idx = buildStockIndex(stocks)
  const results = await pool(posts, Number(arg('concurrency') ?? 8), (p) => gate(client, p, events, check, thinking, tagStocks(p.text, idx)))

  const run = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  const out = new URL(`${run}/`, DIR)
  await Deno.mkdir(out, { recursive: true })
  await Deno.writeTextFile(new URL('results.jsonl', out), results.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const names = new Map(stocks.map((s) => [s.isu_cd, s.isu_nm]))
  const meta = { run, model: GATE_MODEL, prompt: GATE_VERSION, thinking: thinking ? 'adaptive, effort low' : 'disabled', events: events.map((e) => e.id).join(', ') || '–' }
  await Deno.writeTextFile(new URL('report.md', out), report(results, names, meta))
  console.log(`wrote ${out.pathname}report.md`)
}

// Re-runs the checks on a saved run's model output (no model calls): for changes to the checker or the alias lists
async function recheck(runId: string) {
  const read = async <T>(f: string): Promise<T> => JSON.parse(await Deno.readTextFile(new URL(f, DATA)))
  const stocks = await read<Stock[]>('stocks.json')
  const check = checker(stocks, await read<UsSymbol[]>('us_symbols.json'))
  const dir = new URL(`${runId}/`, DIR)
  const results = (await Deno.readTextFile(new URL('results.jsonl', dir))).trim().split('\n').map((l) => JSON.parse(l) as Result)
    .map((r) => (r.reason === 'model' && !r.error ? { ...r, ...check(r.companies) } : r))
  await Deno.writeTextFile(new URL('results.jsonl', dir), results.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const report0 = await Deno.readTextFile(new URL('report.md', dir))
  const meta = Object.fromEntries([...report0.matchAll(/^- (run|model|prompt|thinking|events): (.*)$/gm)].map((m) => [m[1], m[2]]))
  meta.rechecked = new Date().toISOString().slice(0, 16)
  await Deno.writeTextFile(new URL('report.md', dir), report(results, new Map(stocks.map((s) => [s.isu_cd, s.isu_nm])), meta))
  console.log(`rechecked ${results.length} posts, wrote ${dir.pathname}report.md`)
}

if (import.meta.main) {
  const [cmd, n] = Deno.args
  if (cmd === 'export') await exportData(Number(n ?? 14))
  else if (cmd === 'symbols') await exportSymbols()
  else if (cmd === 'run') await run()
  else if (cmd === 'recheck' && n) await recheck(n)
  else console.log('usage: deno task tg-gate export [days] | symbols | run [--limit N] [--concurrency N] [--thinking] | recheck <run>')
}
