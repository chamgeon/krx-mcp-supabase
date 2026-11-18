// Warm benchmark of the read-only MCP tools against the deployed function (production data volume; the local seed is
// too small to time anything). Calls in a round run back to back, so after each case's warm-up they reuse running
// workers. For cold calls (new workers, what occasional real usage sees) use scripts/bench_cold.ts.
//
// For each call it records:
//   total  client wall time of the tools/call request (what a user waits for, minus the LLM)
//   tool   server-side latency_ms, returned in the result's _meta (the tool handler only, as in tool_calls)
//   fwd    forward_ms from _meta: the landing worker → the worker next to the database starting (one way; includes
//          that worker's start-up when it is new). — when the call landed in the database's region (not forwarded).
//
//   deno task bench                         # 50 calls per case: 5 rounds of 10, 60 s apart, after 1 warm-up
//   deno task bench --region us-east-1      # land where Claude's calls land, and be forwarded from there
//   deno task bench --n 20 --rounds 2 --pause 10
//   deno task bench --only get_telegram_feed
//
// A round's first call after the pause may land on new workers (reuse seen up to ~60 s idle); the other calls of the
// round are warm.
//
// --region sets Supabase's x-region header, so the request lands in that region instead of the one nearest this
// machine. tool and fwd then match calls from Claude (us-east-1); total still includes the trip from here.
// Cases, arguments and the unlogged benchmark key: scripts/bench_shared.ts. Results go to bench-results/<run id>.json
// (gitignored).

import {
  arg, type Call, callOnce, CASES, connect, lpad, MCP, ms, nums, p5095, pad, printSteps, region, regions, RUN, save,
  stopIfLogged,
} from './bench_shared.ts'

const N = Number(arg('n') ?? 50)
const ROUNDS = Math.max(1, Math.min(N, Number(arg('rounds') ?? 5)))
const PAUSE_S = Number(arg('pause') ?? 60)
const ONLY = arg('only') ?? ''
const REGION = region()

type WarmCall = Call & { round: number; warmup: boolean }

const client = await connect(REGION)
const cases = CASES.filter((c) => !ONLY || c.tool === ONLY)
const calls: WarmCall[] = []

const perRound = Array.from({ length: ROUNDS }, (_, r) => Math.floor(N / ROUNDS) + (r < N % ROUNDS ? 1 : 0))
console.log(
  `run ${RUN}: ${cases.length} cases × ${N} calls (${ROUNDS} rounds, ${PAUSE_S}s apart) + 1 warm-up each` +
    (REGION ? `, landing in ${REGION}` : ''),
)
for (const c of cases) {
  calls.push({ ...await callOnce(client, c), round: 0, warmup: true })
  if (calls.length === 1) await stopIfLogged(client, calls[0])
}
for (let r = 0; r < ROUNDS; r++) {
  if (r > 0) await new Promise((res) => setTimeout(res, PAUSE_S * 1000))
  for (const c of cases) {
    for (let i = 0; i < perRound[r]; i++) calls.push({ ...await callOnce(client, c), round: r + 1, warmup: false })
  }
  console.log(`  round ${r + 1}/${ROUNDS} done`)
}
await client.close()

// ---- report ---------------------------------------------------------------------------------------

const report = cases.map((c) => {
  const xs = calls.filter((x) => x.label === c.label && !x.warmup && !x.error)
  const total = xs.map((x) => x.total_ms)
  const warm = calls.find((x) => x.label === c.label && x.warmup)!
  return {
    label: c.label,
    n: xs.length,
    errors: calls.filter((x) => x.label === c.label && x.error).length,
    kb: xs.length ? Math.round(xs[0].bytes / 1024) : 0,
    warmup: { total: warm.total_ms, tool: warm.tool_ms, forward: warm.forward_ms },
    total: { ...p5095(total), max: Math.max(...total) },
    tool: p5095(nums(xs.map((x) => x.tool_ms))),
    forward: p5095(nums(xs.map((x) => x.forward_ms))),
  }
})

console.log(`\nlanded in ${regions(calls, (c) => c.landed_in)} · ran in ${regions(calls, (c) => c.handled_in)}`)
const cols = ['n', 'err', 'KB', 'warm-up', 'total p50', 'p95', 'max', 'tool p50', 'p95', 'fwd p50', 'p95']
console.log('\n' + pad('case', 30) + cols.map((h, i) => lpad(h, i < 3 ? 4 : 10)).join(''))
for (const r of report) {
  console.log(
    pad(r.label, 30) + [r.n, r.errors, r.kb].map((v) => lpad(String(v), 4)).join('') +
      [r.warmup.total, r.total.p50, r.total.p95, r.total.max, r.tool.p50, r.tool.p95, r.forward.p50, r.forward.p95]
        .map((v) => lpad(ms(v), 10)).join(''),
  )
}
console.log('* not used in real calls yet')
console.log('fwd: landing region → database region, one way (— = not forwarded)')

printSteps(cases, calls.filter((x) => !x.warmup))
const errs = calls.filter((c) => c.error)
if (errs.length) console.log('\nerrors:\n  ' + errs.slice(0, 5).map((e) => `${e.label}: ${e.error}`).join('\n  '))

await save(
  `${RUN}.json`,
  JSON.stringify({ run: RUN, target: MCP, region: REGION || null, n: N, rounds: ROUNDS, pause_s: PAUSE_S, report, calls }, null, 1),
)
console.log(`\nsaved bench-results/${RUN}.json`)
