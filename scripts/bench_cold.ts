// Cold benchmark: every call on new workers, as occasional real usage sees it (requirements PERF-7, PERF-9–11).
//
// A worker lives at most 150 s on the free plan (Supabase docs) and was never reused after 90 s idle (log 2026-11-17).
// So the run waits --pause seconds (default 150) before every call, including the first (connecting is a request too),
// and goes round-robin over the cases: all of them are cold, with no --only needed.
// One session for the whole run: initialize and tools/list are answered in the landing region (forward.ts), and the
// pause retires that worker as well, so each call pays both start-ups.
//
//   deno task bench:cold                                  # every case × 5, landing in us-east-1: ~2 h
//   deno task bench:cold --n 3 --only get_stock_history   # one tool (matches the tool name): ~8 min
//   deno task bench:cold --only analyze_stock,screen_stocks   # several tools, comma-separated
//   deno task bench:cold --region ap-south-1              # land next to the database (no forward)
//
// Real traffic keeps arriving during the run, and a worker it starts can be reused by a benchmark call shortly after.
// Calls start at a known time (`at`), so the run writes bench-results/<run id>-cold.sql, which drops every call with
// a real tool_call in the 150 s before it and gives the clean per-case numbers:
//   supabase db query --remote --read-only -f bench-results/<run id>-cold.sql
// The report printed here includes every call; use the SQL's numbers for requirements.md §2.3.
//
// Results are saved after every call (bench-results/<run id>-cold.json), so an interrupted run keeps what it has.
// Cases, arguments and the unlogged benchmark key: scripts/bench_shared.ts.

import {
  arg, type Call, callOnce, CASES, connect, lpad, MCP, ms, nums, p5095, pad, printSteps, region, regions, RUN, save,
  stopIfLogged,
} from './bench_shared.ts'

const N = Math.max(1, Number(arg('n') ?? 5))
const PAUSE_S = Number(arg('pause') ?? 150)
const ONLY = (arg('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const REGION = region('us-east-1')
const WINDOW_S = 150 // real calls this long before a benchmark call may have left a worker running

if (PAUSE_S < 150) console.warn(`--pause ${PAUSE_S}: under 150 s a worker may survive, so calls may not be cold`)

const unknown = ONLY.filter((t) => !CASES.some((c) => c.tool === t))
if (unknown.length) {
  console.error(`--only: no case for tool ${unknown.join(', ')} (tools: ${[...new Set(CASES.map((c) => c.tool))].join(', ')})`)
  Deno.exit(1)
}
const cases = CASES.filter((c) => !ONLY.length || ONLY.includes(c.tool))

type ColdCall = Call & { i: number; sample: number }
const calls: ColdCall[] = []
const sleep = () => new Promise((res) => setTimeout(res, PAUSE_S * 1000))
const total = cases.length * N
const hhmm = (s: number) => `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`

console.log(
  `run ${RUN}: ${cases.length} cases × ${N} cold calls, ${PAUSE_S}s before each, landing in ${REGION}` +
    ` (~${hhmm(total * PAUSE_S)})`,
)
const client = await connect(REGION)

for (let s = 1; s <= N; s++) {
  for (const c of cases) {
    await sleep()
    const call: ColdCall = { ...await callOnce(client, c), i: calls.length, sample: s }
    calls.push(call)
    if (calls.length === 1) await stopIfLogged(client, call)
    console.log(
      `  [${lpad(String(calls.length), String(total).length)}/${total}] ${call.at.slice(11, 19)}Z ${pad(c.label, 30)}` +
        `total ${lpad(ms(call.total_ms), 5)}  tool ${lpad(ms(call.tool_ms), 5)}  fwd ${lpad(ms(call.forward_ms), 5)}` +
        (call.error ? `  error: ${call.error}` : ''),
    )
    await saveRun()
  }
}
await client.close()

// ---- report ---------------------------------------------------------------------------------------

const report = cases.map((c) => {
  const xs = calls.filter((x) => x.label === c.label && !x.error)
  const t = xs.map((x) => x.total_ms)
  return {
    label: c.label,
    n: xs.length,
    errors: calls.filter((x) => x.label === c.label && x.error).length,
    kb: xs.length ? Math.round(xs[0].bytes / 1024) : 0,
    total: { ...p5095(t), max: Math.max(...t) },
    tool: p5095(nums(xs.map((x) => x.tool_ms))),
    forward: p5095(nums(xs.map((x) => x.forward_ms))),
  }
})

console.log(`\nlanded in ${regions(calls, (c) => c.landed_in)} · ran in ${regions(calls, (c) => c.handled_in)}`)
console.log('all calls, before dropping those real traffic may have warmed (see the SQL below):')
const cols = ['n', 'err', 'KB', 'total p50', 'p95', 'max', 'tool p50', 'p95', 'fwd p50', 'p95']
console.log('\n' + pad('case', 30) + cols.map((h, i) => lpad(h, i < 3 ? 4 : 10)).join(''))
for (const r of report) {
  console.log(
    pad(r.label, 30) + [r.n, r.errors, r.kb].map((v) => lpad(String(v), 4)).join('') +
      [r.total.p50, r.total.p95, r.total.max, r.tool.p50, r.tool.p95, r.forward.p50, r.forward.p95]
        .map((v) => lpad(ms(v), 10)).join(''),
  )
}
console.log('* not used in real calls yet')
console.log('fwd: landing region → database region, one way (— = not forwarded)')
printSteps(cases, calls)

await saveRun(report)
await save(`${RUN}-cold.sql`, checkSql())
console.log(
  `\nsaved bench-results/${RUN}-cold.json and ${RUN}-cold.sql. Clean numbers (warmed calls dropped):\n` +
    `  supabase db query --remote --read-only -f bench-results/${RUN}-cold.sql`,
)

// ---- output ---------------------------------------------------------------------------------------

function saveRun(report?: unknown) {
  return save(
    `${RUN}-cold.json`,
    JSON.stringify({ run: RUN, kind: 'cold', target: MCP, region: REGION, n: N, pause_s: PAUSE_S, report, calls }, null, 1),
  )
}

/**
 * Per case: calls kept (no real tool_call in the WINDOW_S before), calls dropped (with how long after a real call),
 * and p50/p95 of the kept calls. Benchmark calls aren't logged, so every tool_calls row is real traffic; all regions
 * count, because the worker next to the database serves every forwarded call.
 */
function checkSql(): string {
  const num = (x: number | null) => (x == null ? 'null' : String(Math.round(x)))
  const rows = calls.filter((c) => !c.error).map((c) =>
    `  (${c.i}, '${c.label.replaceAll("'", "''")}', '${c.at}'::timestamptz, ${num(c.total_ms)}, ${num(c.tool_ms)}, ` +
    `${num(c.forward_ms)})`
  )
  if (!rows.length) return `-- Cold run ${RUN}: no successful calls.\nselect 'no successful calls' as note;\n`
  return `-- Cold run ${RUN} (${REGION}, ${PAUSE_S} s pause): per case, calls kept and dropped, and cold p50/p95 of the
-- kept ones. Dropped: a real tool_call came in the ${WINDOW_S} s before, so the call may have reused its worker.
-- dropped lists "#call (seconds after the real call)". Run read-only:
--   supabase db query --remote --read-only -f bench-results/${RUN}-cold.sql
with b(i, label, at, total_ms, tool_ms, fwd_ms) as (values
${rows.join(',\n')}
),
checked as (
  select b.*, count(t.id) as real_before, round(extract(epoch from b.at - max(t.ts)))::int as s_since_real
  from b left join public.tool_calls t on t.ts > b.at - interval '${WINDOW_S} seconds' and t.ts <= b.at
  group by b.i, b.label, b.at, b.total_ms, b.tool_ms, b.fwd_ms
)
select label,
       count(*) filter (where real_before = 0)::int as kept,
       count(*) filter (where real_before > 0)::int as dropped_n,
       string_agg('#' || i || ' (' || s_since_real || ' s)', ', ' order by i) filter (where real_before > 0) as dropped,
       percentile_disc(0.5) within group (order by total_ms) filter (where real_before = 0) as total_p50,
       percentile_disc(0.95) within group (order by total_ms) filter (where real_before = 0) as total_p95,
       percentile_disc(0.5) within group (order by tool_ms) filter (where real_before = 0) as tool_p50,
       percentile_disc(0.95) within group (order by tool_ms) filter (where real_before = 0) as tool_p95,
       percentile_disc(0.5) within group (order by fwd_ms) filter (where real_before = 0) as fwd_p50,
       percentile_disc(0.95) within group (order by fwd_ms) filter (where real_before = 0) as fwd_p95
from checked
group by label
order by min(i);
`
}
