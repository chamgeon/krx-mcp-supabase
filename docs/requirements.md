# Requirements

What the system must do, and how well. Each requirement has an ID so tests, commits and alerts can refer to it
("fixes PERF-3").

Priority (MoSCoW): **M** must, **S** should, **C** could.
Status: ✅ met · ⚠️ at risk or currently breached · ❔ not measured yet.

Baselines were measured on 2026-11-18 from production (`tool_calls`, `ingest_runs`) and `bench-results/`. Sample sizes
are small (dozens of calls per tool, ~2 days of ingest runs), so re-baseline after a month of traffic (see
[Measuring](#measuring)).

## Definitions

| Term | Meaning |
|---|---|
| **server latency** | `tool_calls.latency_ms`: the tool handler only, in production. Includes cold DB/worker setup, because on the free plan most calls start a new worker. |
| **warm latency** | `tool` column of `scripts/bench.ts` (`scripts/bench_cold.ts` for cold): server latency once a worker is running. |
| **end-to-end** | `total` column of `scripts/bench.ts`: what a client in us-east-1 sees, including the region forward hop to ap-south-1. |
| **hop** | `tool_calls.forward_ms`: landing region → DB region, one way. |
| **user error** | an error caused by bad input (unknown stock, non-trading date, invalid channel). Not counted against error-rate targets. |
| **trading day** | a weekday KRX is open; times below are KST. |

Percentiles are over a rolling 7 days unless stated. Latency targets use p95/p99, never max: one cold start would
break any max.

---

## 1. Functional requirements

These restate the behaviour described in the [README](../README.md#tools) as testable statements. The acceptance test
column points at the test that proves it, or is empty where none exists yet.

### Market data tools

| ID | P | Requirement | Acceptance test |
|---|---|---|---|
| FR-MOV-1 | M | `get_daily_movers` sheet1 = every stock with 등락률 ≥ +15%, sorted by 등락률 descending. | mcp_test: "get_daily_movers: sheets on a final day" |
| FR-MOV-2 | M | sheet2 = 등락률 ≥ +7% and 거래대금 ≥ 500억, excluding sheet1 rows, sorted by 등락률. | mcp_test: "get_daily_movers: sheets on a final day" |
| FR-MOV-3 | M | sheet3 = 일봉/주봉/월봉 chart URLs for the stocks in sheets 1–2. | |
| FR-MOV-4 | M | With no date, uses the latest trading day with data, and says whether it is final (KRX) or provisional (KIS). | mcp_test: "get_daily_movers: latest day is the intraday snapshot" |
| FR-SCR-1 | M | `screen_stocks` applies every filter documented in the README; omitted filters don't restrict results. | db_test (one test per filter); mcp_test: "screen_stocks: filters reach SQL" |
| FR-SCR-2 | M | Returns at most `limit` rows (1–500, default 100) and sets `truncated` when more matched. | db_test: "sort and limit" |
| FR-ANA-1 | M | `analyze_stock` accepts a 종목명 or 종목코드 and returns the quantitative profile plus triggered signals. | `mcp/analyze_test.ts`; db_test: "screen_stocks and analyze() agree" |
| FR-ANA-2 | S | During the session (09:00–15:30 trading days), also returns a live KIS quote; if KIS fails, returns the rest without it. | |
| FR-HIS-1 | M | `get_stock_history` returns the most recent `days` (1–250, default 20) daily OHLCV rows. | mcp_test: "get_stock_history" |
| FR-FND-1 | M | `find_stock` maps a 종목명 (partial match allowed) to 종목코드. | mcp_test: "find_stock" |
| FR-DAT-1 | M | `check_available_dates` without a date returns total, first and last trading day; with a date, whether it has final or provisional data, or the nearest trading days on each side. | mcp_test: "check_available_dates: range, a final day, a missing day" |
| FR-ERR-1 | M | Bad input (unknown stock, non-trading day, out-of-range parameter) returns an error message that tells the caller what to do instead, not a stack trace. | mcp_test: "invalid arguments are rejected by the schema", "a weekend says so", "unknown and ambiguous names" |

### Telegram tools

| ID | P | Requirement | Acceptance test |
|---|---|---|---|
| FR-TG-1 | M | `add_telegram_channel` accepts only public channels with a `t.me/s/<name>` preview, stores the newest page and returns the latest posts; the rest of ~30 days (at most 8 pages in all) is collected in the background, and resumed by `telegram-ingest` if interrupted. | mcp_test: "add_telegram_channel: invalid name is refused"; db_test: "telegram backfill: …" (5 tests) |
| FR-TG-2 | M | `get_telegram_feed` returns the user's followed channels (or all, with `all_channels`), newest first, with links and the stocks each post mentions. | mcp_test: "get_telegram_feed: all channels, by channel, by stock" |
| FR-TG-3 | M | `search_telegram` returns posts containing all query words, with a snippet and link. | mcp_test: "search_telegram: every word must match" |
| FR-TG-4 | M | `set_my_channels` / `update_my_channels` collect channels that aren't collected yet before following them. | mcp_test: "channel preferences: set, update, feed scope" |
| FR-TG-5 | M | A user's followed channels are visible and editable only by that user. | mcp_test: "channel preferences need a logged-in user" |
| FR-TG-6 | M | While a channel's older posts are still being collected, `get_telegram_feed` and `search_telegram` say so (`still_collecting`, with the time collected from) when the requested window starts before that time, and only then. | mcp_test: "feed and search say when a channel is still filling" |

### Data pipeline

| ID | P | Requirement | Acceptance test |
|---|---|---|---|
| FR-ING-1 | M | KIS provisional rows for a day are replaced by KRX official rows once KRX publishes that day. | db_test: "prices view hides live rows for days KRX already published" |
| FR-ING-2 | M | An ingest batch that fails sanity checks (row count, 6-char 종목코드, no duplicates, OHLC order, 등락률 within ±30.5%; > max(5, 1%) bad rows = failure) is refused, existing data is kept, and the run fails visibly. | `_shared/validate_test.ts` |
| FR-ING-3 | M | Every ingest run writes one `ingest_runs` row when it starts (running, with progress) and completes it at the end, whether it succeeds or fails. | db_test: "monitored: a run is recorded with its answer", "the row is written when the run starts" |
| FR-ING-4 | M | A failed run sends a Telegram alert immediately, at most one per job per hour. | db_test: "monitored: a failure alerts once per hour" |
| FR-ING-5 | M | A daily report at 18:00 KST summarizes ingest runs and the KIS vs KRX close-price comparison. | `pipeline-report/report_test.ts` |
| FR-ING-6 | M | A run stopped at the Edge Function time limit (so it never completes its row) is marked failed and alerted within 5 minutes, with the progress it had saved. | db_test: "a run stopped at the time limit is marked failed and alerted" |
| FR-ING-7 | S | Errors in alerts and `last_error` are readable: an HTML error page from a gateway is reduced to its title. | `_shared/errors_test.ts`; db_test: "an HTML error page is recorded and alerted as its title" |

---

## 2. Non-functional requirements

### 2.1 Performance: server latency (production)

Tools fall into three tiers by the work they do.

| Tier | Tools |
|---|---|
| **A: lookups** | `find_stock`, `check_available_dates`, `get_stock_history`, `get_daily_movers`, `get_telegram_feed`, `search_telegram`, `list_telegram_channels`, `get_my_channels` |
| **B: compute** | `screen_stocks`, `analyze_stock` (live KIS quote during the session) |
| **C: scrape** | `add_telegram_channel`, and `set_my_channels` / `update_my_channels` when they add a channel not yet collected |

| ID | P | Requirement | Baseline (since 11-17 02:00 UTC unless noted) | Status |
|---|---|---|---|---|
| PERF-1 | M | Tier A server latency p95 ≤ 1,000 ms, p99 ≤ 2,000 ms | feed p95 589 (n=35), movers 503 (n=9), search 387, history **1,504** (n=3) | ⚠️ history |
| PERF-2 | M | Tier B server latency p95 ≤ 2,000 ms, p99 ≤ 4,000 ms | analyze p95 1,881 (n=4), screen 1,550 (n=1) | ✅ (thin data) |
| PERF-3 | S | Tier C server latency p95 ≤ 5 s per new channel (one t.me page; the rest in the background), and always below the Edge Function wall-clock limit | 11-18 with the background backfill: add_channel 1,991 ms (n=1; before: 13.6–21.6 s) | ✅ (n=1) |
| PERF-4 | S | Tier C calls that touch only already-collected channels meet the Tier A target | not separated in logs yet | ❔ |

### 2.2 Performance: warm (`scripts/bench.ts`, default pause, client in us-east-1)

Calls in a round run back to back, so after the warm-up call they reuse running workers.

| ID | P | Requirement | Baseline (bench 11-17 after-parallel) | Status |
|---|---|---|---|---|
| PERF-5 | S | Warm server latency p95: Tier A ≤ 250 ms, Tier B ≤ 800 ms | A: 49–133 ms except feed(1h) 453; B: analyze 787, screen 337 | ⚠️ feed(1h) |
| PERF-6 | M | Warm end-to-end p95: Tier A ≤ 1,500 ms, Tier B ≤ 2,500 ms | A: 412–854 ms except feed(1h) **1,668**; B: analyze 1,637, screen 839 | ⚠️ feed(1h) |
| PERF-8 | S | Forward hop p95 ≤ 1,000 ms | p95 800 ms, p50 523 (n=53, us-east-1) | ✅ |

### 2.3 Performance: cold (`scripts/bench_cold.ts`)

What occasional usage sees (one Claude/ChatGPT call every few minutes). A worker lives at most 150 s on the free plan,
so the cold benchmark waits 150 s before every call and goes round-robin over the cases: every call starts new workers
in both the landing region (us-east-1 by default, where Claude's calls land) and the database region.

```
deno task bench:cold                                   # every case × 5: ~2 h
deno task bench:cold --n 3 --only get_stock_history    # one tool: ~8 min
```

Tier C tools aren't covered (the benchmark doesn't call write tools).

**Calls real traffic may have warmed are dropped.** Production keeps serving real calls during the run, and a worker
they start can be reused by a benchmark call shortly after (reuse seen up to ~60 s idle, never after 90 s: log
2026-11-17). The run writes `bench-results/<run id>-cold.sql`, which drops every call with a real `tool_call` in the
150 s before it (any region: the worker next to the database serves every forwarded call) and returns per case the
calls kept and dropped and the cold p50/p95 of the kept ones. Use these numbers, not the run's printed report:

```
supabase db query --remote --read-only -f bench-results/<run id>-cold.sql
```

Also suspect a kept call whose `fwd` is ~100–130 ms (a warm hop; cold is ~500 ms and more). Fewer drops: run outside
the busy hours (12, 15–16 and 19 KST in `tool_calls`), e.g. before 07:00 or 20:00–23:00 KST.

| ID | P | Requirement | Baseline | Status |
|---|---|---|---|---|
| PERF-7 | M | Cold end-to-end p95: Tier A ≤ 3,000 ms, Tier B ≤ 4,000 ms | 11-18, all 10 cases, n=4–5: Tier A 2,914–4,718 (2 of 8 within), Tier B 5,585 and 6,482 | ❌ 8 of 10 over |
| PERF-9 | S | Cold server latency p95: Tier A ≤ 1,500 ms, Tier B ≤ 2,500 ms | 11-18: Tier A 572–1,060; analyze_stock 1,991, screen_stocks **2,511** | ⚠️ screen_stocks just over |
| PERF-10 | S | Cold forward hop p95 ≤ 1,500 ms (includes the DB-region worker's start-up) | 11-18: 980–1,171 for 7 cases; **2,211** (list_telegram_channels), **2,908** (analyze_stock), **3,229** (check_available_dates, at 12:00 KST during the gateway slowdown) | ⚠️ 3 of 10 over |
| PERF-11 | C | Cold penalty (cold p50 − warm p50, end-to-end) ≤ 1,500 ms per tool | 11-18 cold vs 11-17 warm p50: +2.1 to +3.5 s for every case (screen_stocks +3.5, analyze_stock +3.35) | ❌ all |

Results (fill in from `bench-results/`). `total` is measured from the benchmark machine in Korea to us-east-1, so it
includes that trip; `tool` and `fwd` match real calls from Claude:

| Tool | Tier | Run (kept / dropped) | total p50 / p95 | tool p50 / p95 | fwd p50 / p95 |
|---|---|---|---|---|---|
| find_stock | A | 20261118T023156Z (5 / 0) | 2,386 / 2,981 | 631 / 686 | 779 / 1,067 |
| check_available_dates | A | 20261118T025820Z (4 / 1) | 2,881 / 4,718 | 568 / 770 | 969 / 3,229 |
| get_stock_history (20d) | A | 20261118T035717Z (5 / 0) | 2,492 / 3,137 | 687 / 730 | 672 / 1,099 |
| get_daily_movers (latest) | A | 20261118T032359Z (5 / 0) | 2,941 / 4,000 | 513 / 572 | 715 / 1,061 |
| get_telegram_feed (1h, 30) | A | 20261118T035717Z (5 / 0) | 2,629 / 2,914 | 595 / 861 | 677 / 1,036 |
| get_telegram_feed (20h, 50) | A | 20261118T035717Z (5 / 0) | 3,196 / 3,361 | 624 / 1,060 | 1,067 / 1,110 |
| search_telegram (60h, 10) | A | 20261118T035717Z (5 / 0) | 2,616 / 4,659 | 721 / 846 | 688 / 980 |
| list_telegram_channels | A | 20261118T035717Z (5 / 0) | 2,880 / 4,140 | 550 / 798 | 1,054 / 2,211 |
| screen_stocks (spike) | B | 20261118T035717Z (4 / 1) | 4,027 / 5,585 | 2,039 / 2,511 | 638 / 1,171 |
| analyze_stock (latest) | B | 20261118T035717Z (5 / 0) | 3,805 / 6,482 | 1,443 / 1,991 | 1,113 / 2,908 |

### 2.4 Response size

Responses go into an LLM's context window, so size is a cost and a quality issue.

| ID | P | Requirement | Baseline (all time) | Status |
|---|---|---|---|---|
| SIZE-1 | S | Response p95 ≤ 20 KB per tool | max p95: feed 16 KB, movers 14 KB, history **59 KB** | ⚠️ history |
| SIZE-2 | M | No response > 64 KB; larger results are truncated and say so | history max **68 KB** (`days` up to 250) | ⚠️ history |

### 2.5 Reliability

| ID | P | Requirement | Baseline | Status |
|---|---|---|---|---|
| REL-1 | M | Tool error rate, excluding user errors, < 1% per week | 0 errors / 161 calls | ✅ |
| REL-2 | M | Ingest job success rate ≥ 99% per week per job | 0 failures (kis 17, krx 4, telegram 198 runs) | ✅ |
| REL-3 | S | A KIS outage degrades `analyze_stock` (no live quote) instead of failing it | | ❔ |
| REL-4 | M | Weekly backup succeeds (Mondays 03:00 KST); RPO ≤ 7 days | `.github/workflows/backup.yml` | ❔ restore not tested |
| REL-5 | S | Restore from backup is rehearsed once a quarter; RTO ≤ 4 hours | | ❔ |

### 2.6 Data freshness

| ID | P | Requirement | Baseline | Status |
|---|---|---|---|---|
| FRESH-1 | M | During the session (09:00–15:30 trading days), provisional data is ≤ 10 min old | KIS cron every 5 min 09:00–15:55; run p95 45 s | ✅ |
| FRESH-2 | M | Closing provisional data exists by 16:00 KST | KIS close run 15:40, after-hours runs 16:00 and 18:00 | ✅ |
| FRESH-3 | M | KRX official data for trading day D is loaded by 09:00 KST on D+1 | KRX cron 07:00–08:30 every 30 min | ✅ |
| FRESH-4 | S | Telegram posts are collected ≤ 10 min after posting | telegram cron every 5 min, run p95 7.4 s | ✅ |
| FRESH-5 | M | A failed ingest is alerted within 5 min of the run finishing | alert sent by the run itself (FR-ING-4) | ✅ |

### 2.7 Ingest runtime

| ID | P | Requirement | Baseline | Status |
|---|---|---|---|---|
| ING-1 | M | Every ingest run finishes within the Edge Function wall-clock limit with ≥ 25% headroom | krx max **126 s**, p95 112 s; kis: 129 s and 135 s on 11-18, and two runs stopped at 150 s (11:55, 12:00 KST) | ⚠️ krx, kis |
| ING-2 | S | kis-ingest p95 ≤ 60 s, so 5-min runs never overlap | p95 45 s | ✅ |
| ING-3 | S | telegram-ingest p95 ≤ 30 s | p95 7.4 s | ✅ |

### 2.8 Data correctness

| ID | P | Requirement | Baseline | Status |
|---|---|---|---|---|
| CORR-1 | M | KIS vs KRX close-price mismatches ≤ 0.5% of compared stocks per day (reported at 18:00) | in daily report | ❔ add threshold |
| CORR-2 | M | No two rows for the same (종목코드, date) | primary key | ✅ |
| CORR-3 | M | Every `screen_stocks` filter and every `get_daily_movers` rule has a fixture-based test | db_test covers each filter; movers sheet3 untested | ⚠️ |
| CORR-4 | M | All numbers come from SQL/TypeScript over stored data; no LLM on the server | by design | ✅ |

### 2.9 Capacity and cost (Supabase free plan)

| ID | P | Requirement | Baseline | Status |
|---|---|---|---|---|
| CAP-1 | M | Database ≤ 400 MB (80% of the 500 MB free limit); alert when exceeded | 283 MB (57%) | ✅ |
| CAP-2 | M | KRX API calls ≤ 10,000 per day, including backfill | | ✅ |
| CAP-3 | M | KIS calls stay under the per-second limit; on a limit error, back off and retry | `_shared/kis.ts` | ✅ |
| CAP-4 | S | `ingest_runs` keeps 90 days; `tool_calls` has a retention policy | ingest 90 d; tool_calls unbounded | ⚠️ tool_calls |
| CAP-5 | S | Monthly Edge Function invocations ≤ 80% of the free quota | | ❔ |
| CAP-6 | M | Running cost stays $0/month | | ✅ |

### 2.10 Security and compliance

| ID | P | Requirement | Status |
|---|---|---|---|
| SEC-1 | M | Every MCP call is authenticated (OAuth or shared key); unauthenticated calls are rejected (mcp_test: "no token: 401", "wrong ?key= and invalid tokens are rejected") | ✅ |
| SEC-2 | M | `tool_calls`, `ingest_runs` and user channel data are readable only by the service role or their owner (RLS) | ✅ |
| SEC-3 | M | `tool_calls` stores tool arguments only, never prompts or secrets | ✅ |
| SEC-4 | M | KRX data is not redistributed to third parties: each deployment uses its own KRX key | ✅ |
| SEC-5 | M | Tests run only against `supabase/tests/functions.env` (dummy keys), never `supabase/.env` | ✅ |
| SEC-6 | S | Telegram channels are joined slowly to avoid an account ban | ✅ |

---

## Open issues

Issues found against these requirements are tracked under **Open** in [log.md](log.md).

## Measuring

Production server latency per tool (PERF-1–4):

```sql
select tool, count(*) n,
       percentile_cont(0.95) within group (order by latency_ms)::int p95,
       percentile_cont(0.99) within group (order by latency_ms)::int p99,
       count(*) filter (where not ok) errors
from tool_calls where ts > now() - interval '7 days'
group by 1 order by n desc;
```

Response size (SIZE-1, SIZE-2):

```sql
select tool, percentile_cont(0.95) within group (order by response_bytes)::int p95_bytes, max(response_bytes) max_bytes
from tool_calls where ts > now() - interval '7 days' group by 1 order by 3 desc;
```

Ingest runtime and success (REL-2, ING-1–3):

```sql
select job, count(*) runs, count(*) filter (where not ok) fails,
       percentile_cont(0.95) within group (order by ms)::int p95_ms, max(ms) max_ms
from ingest_runs where started_at > now() - interval '7 days' group by 1;
```

Forward hop (PERF-8): see the query in `supabase/migrations/20261117000000_tool_call_forward.sql`.
Database size (CAP-1): `select pg_size_pretty(pg_database_size(current_database()));`

Warm latency (PERF-5, PERF-6): `deno task bench --region us-east-1`. Cold latency (PERF-7, PERF-9–11):
`deno task bench:cold`, see [2.3](#23-performance-cold-scriptsbench_coldts). Results go to `bench-results/`.

Run any of these against production read-only with `supabase db query --remote --read-only "<sql>"`.
