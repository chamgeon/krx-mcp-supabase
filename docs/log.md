# Design Log

What was done and why. Oldest first; new entries go at the bottom.

## 2026-10-11 — Architecture
- **Done:** runs entirely on the Supabase free plan: Edge Functions on a schedule load data into Postgres, and one Edge
  Function serves it over MCP. All numbers come from SQL/TS; the LLM is used only on the client side.
  **Why:** no cost, and the numbers are reproducible.
- **Done:** each user registers their own KRX key. **Why:** KRX's terms don't allow passing the data on to third
  parties.
- **Done:** a secret `?key=` in the URL, and RLS with no policies. **Why:** Edge Functions have no built-in auth for MCP;
  only the service role can read the data.

## 2026-10-11 — `screen_stocks` performance
- **Done:** covering index `daily_prices_screen_idx`, read through a `materialized` CTE. Window functions run only over
  ~21 days, and 60/120-day highs are computed only when asked. **Why:** PostgREST's 8 s timeout. Fetching ~350k rows
  from the table in random order timed out; now a full-market screen takes 0.2–0.5 s.

## 2026-10-29 — Intraday data from KIS
- **Done:** `kis-ingest` takes a whole-market snapshot every 5 minutes plus after the close. KRX's official data
  replaces it the next morning, and tools return `data_status`. **Why:** KRX publishes a day only the next morning.
- **Done:** the stock list, market, 소속부 and 상장주식수 are carried forward from the previous day. **Why:** KIS has no
  whole-market endpoint.
- **Done:** the KIS token is cached in `kis_token`. **Why:** KIS limits how often a token can be issued.

## 2026-10-29 — Untraded days
- **Done:** zero high/low are treated as missing, and a stock with no trades that day is never a breakout. **Why:**
  KRX reports halted stocks with high/low = 0, which made them false breakouts.

## 2026-11-10 — Plan pivot
- **Done:** Telegram data became Phase 1. DART and valuation went to the backlog; the knowledge graph and hypothesis
  backtesting were dropped. **Why:** the PB interview. Insight comes from experts on Telegram, PBs don't want AI
  "insight", and backtesting market hypotheses is misleading. See `docs/plan.md`.

## 2026-11-13 — Login and Telegram decisions
- **Decided:** OAuth login (Supabase Auth, Kakao/Google), not per-user URL keys. **Why:** unknown PBs already use the
  server, so there's no way to hand out keys.
- **Decided:** public Telegram channels via the `t.me/s/` preview; private ones via Telethon. **Why:** no account needed
  for public channels. A Telegram bot can't read channels where it isn't an admin.

## 2026-11-13 — DB over 500 MB: index cleanup
- **Done:** dropped `daily_prices_date_rate_idx` and ran `REINDEX` on `daily_prices_screen_idx` (553 → 268 MB).
  **Why:** the indexes were 365 MB against 134 MB of data. One index was redundant, and the other was bloated by
  5-minute rewrites.

## 2026-11-13 — KRX key expired
- **Done:** renewed the key and backfilled 10/30–11/12. `krx-ingest` now returns 500 when a day fails. **Why:** it
  returned 200 with the errors inside the response, so a 401 went unnoticed for two weeks.

## 2026-11-13 — Live/history split
- **Done:** KIS rows go to `live_prices`, KRX rows to `daily_prices`, and readers use the `prices` view. **Why:**
  rewriting today's rows every 5 minutes inside the large table bloated its index. Now the churn stays in a ~1 MB
  table, and history is written once.
- **Done:** ran `VACUUM` after the migration. **Why:** after a big batch of writes, index-only scans keep going back to
  the table until a vacuum runs (990 → 236 ms).

## 2026-11-13 — Usage logging and OAuth login
- **Done:** a `tool_calls` table (user, auth type, client, tool, args, ok/error, latency, size) and a
  `tool_usage_weekly` view. One wrapper around `registerTool` logs every tool, and the insert runs after the response.
  **Why:** the go/no-go decisions in the plan need real usage data.
- **Done:** OAuth 2.1 login with Supabase Auth as the authorization server. The MCP function returns a 401 that points
  to its protected-resource metadata, and verifies tokens locally against the ES256 JWKS. **Why:** we need per-user
  identity for logging and preferences, and handing out keys doesn't work for users we don't know.
- **Done:** the consent page (`web/oauth/consent.html`) is hosted on GitHub Pages. **Why:** Supabase serves HTML from
  Edge Functions and Storage as plain text, so the page needs a static host.
- **Done:** the shared `?key=` URL still works, logged as `shared_key`. **Why:** existing users shouldn't break before
  they reconnect.

## 2026-11-13 — Login tweaks and `available_dates` speed-up
- **Done:** Google is the only login option; Kakao was dropped. **Why:** simpler setup, and Kakao's email consent item
  needs a 비즈 앱.
- **Done:** the server asks only for the `offline_access` scope (in the 401 and in the resource metadata). **Why:**
  without a hint, clients requested every scope Supabase supports (`openid profile email phone`), and the server
  reads none of them. `offline_access` gives a refresh token, so users don't log in again every hour.
- **Done:** a `trading_days` table (one row per KRX day, kept in sync by triggers on `daily_prices`), and
  `available_dates` reads it plus `live_prices`. **Why:** the view counted all 742k rows on every tool call (~3 s
  cold, and a 6 s `list_available_dates`).
- **Done:** replaced `list_available_dates(limit)` with `check_available_dates(date?)`. With no date it returns
  total, first and last day plus the latest day's status; with a date it checks that day, or gives the nearest
  trading days around it. **Why:** `limit` was confusing (Claude asked for 100 and reported "100 days" out of 268), and
  the real questions are "how much history?" and "is this day there?".

## 2026-11-13 — Telegram pipeline (public channels)
- **Done:** public channels are read from the `t.me/s/<name>` web preview (20 posts per page, `?before=` to page
  back) and stored in `telegram_messages`, tagged with the stocks they mention. **Why:** no Telegram account or
  API needed, and it runs in the existing Edge Function and cron setup.
- **Done:** users add channels on demand with `add_telegram_channel`, which checks the preview, backfills ~30 days
  and returns the latest posts. `telegram-ingest` polls every 10 minutes, and reads refresh a channel if its last poll
  is over 5 minutes old. **Why:** PBs read different channels, and the answer should be current.
- **Done:** collection is shared (`telegram_channels`, one row per channel, capped at 50). **Why:** a channel is
  fetched once however many users follow it. Per-user preferences will only choose which channels a user sees.
- **Done:** stock tagging matches names of 3+ characters (longest first) and 6-digit codes. **Why:** 2-character
  names collide with ordinary words.

## 2026-11-13 — Per-user channel preferences
- **Done:** `user_channels(user_id, username)` and three tools: `get_my_channels`, `set_my_channels` (replace the
  list), `update_my_channels` (add/remove). Following an uncollected channel collects it first, and adding a channel
  follows it. **Why:** PBs read different channels; collection stays shared, and preferences only choose the feed.
- **Done:** `get_telegram_feed` without a channel shows the user's channels (`all_channels` for everything; all
  channels if they follow none). **Why:** the feed should default to what the user cares about.
- Preferences are keyed by the Supabase Auth user, so the same Google account sees the same list in ChatGPT and
  Claude. Shared-`?key=` calls have no user and get a "log in" message.
- **Done:** stock tagging also counts `ADR`/`GDR` right after a name and `SK 하이닉스`-style spacing. **Why:** real
  posts write `SK하이닉스ADR` and `SK 하이닉스 ADR`.
- **Done:** the stock-name index loads only when a fetched page has new posts, and is cached per function instance
  for 6 hours. Posts we already have are upserted without `stock_codes`, so their tags stay. **Why:**
  `get_telegram_feed` and `update_my_channels` took ~8 s because every refresh reloaded ~2,800 names to re-tag posts
  that were already tagged.
- **Done:** `get_telegram_feed` answers from stored posts and refreshes stale channels after the response; the latest
  trading day is cached per instance; `telegram-ingest` runs every 5 minutes instead of 10. **Why:** the feed still
  took ~6.6 s, mostly a Telegram fetch (0.5–2 s) plus ~8 sequential queries before answering. Stored posts are at most
  one cron interval old, which is fresh enough for reading.

## 2026-11-13 — Stay on the free plan, add weekly backups
- **Decided:** no Pro upgrade yet (DB 279 / 500 MB, one logged-in user). Upgrade when PBs come back weekly, the
  database passes ~400 MB, or a branded Google login is wanted. **Why:** validate demand before spending.
- **Done:** a weekly GitHub Action dumps `public` (schema + data) and `auth` data, encrypts it with a passphrase, and
  keeps it 35 days as an artifact. **Why:** the free plan has no backups, and usage logs and user preferences can't be
  re-fetched from anywhere. Encrypted because the dump holds user emails and tokens.

## 2026-11-16 — Backup failure: pin the Supabase CLI
- **Done:** the backup workflow pins the CLI (`version: 3.1.0`) instead of `latest`. **Why:** the 11-16 run failed
  before dumping anything: resolving `latest` hit GitHub's API rate limit. Pinning also keeps a new major version from
  changing `db dump` unnoticed. v3.1.0 was tested locally with all three dump commands before the pin was raised from
  2.120.0; bump it the same way.

## 2026-11-16 — Tests: what and how
- **Decided:** test correctness and the tool contract, not latency or concurrency. **Why:** traffic is one person;
  real latency is already in `tool_calls` (`tool_usage_weekly` has p50/p95).
- **Done:** three suites, from fast to complete: `deno task test` (unit tests next to the code, `*_test.ts`, no setup),
  `deno task test:db` (`screen_stocks`, views, triggers on the local stack), `deno task test:mcp` (every tool over HTTP
  with the official MCP client, auth, usage logging). See README → Tests. **Why:** Deno's built-in test runner needs
  nothing new; unit tests stay instant, and the ones that need Docker are kept apart.
- **Done:** a local Supabase stack with `supabase/seed.sql`: made-up stocks (9000xx), each shaped to trigger one signal,
  plus a provisional KIS day and two Telegram channels. **Why:** tests need fixed data and must never write to
  production; the migrations alone rebuilding the schema is itself a check.
- **Done:** pure logic moved out of the functions so tests can import it (`mcp/analyze.ts`, `krx-ingest/parse.ts`,
  `kis-ingest/parse.ts`, `buildStockIndex`). No behavior change.
- **Done:** a test that `screen_stocks` (SQL) and `analyze()` (TypeScript) agree on every metric for every seeded stock.
  **Why:** they compute the same definitions in two languages; a change to one alone makes the screen find a stock that
  `analyze_stock` then describes differently.
- Tests were checked by breaking the code on purpose (halted-day check, a response field name, the KRX high/low
  mapping, the Telegram text fix); each break made the expected test fail.

## 2026-11-16 — New listings in `analyze_stock`
- **Decided:** support new IPOs: averages and ratios use the prior days that exist (`avg_prior_days`), the N-day high is
  reported over the days since listing, and the breakout stays null until N prior days exist. A `SHORT_HISTORY` signal
  says so. **Why:** the consistency test found `analyze()` returned null for stocks listed < 21 days ago while
  `screen_stocks` averaged the days available, so a screen could find an IPO that `analyze_stock` couldn't describe.
  Users want to look at new listings; a breakout needs a full window either way.

## 2026-11-16 — Local login: `PUBLIC_SUPABASE_URL`
- **Done:** the issuer check and the OAuth metadata use `PUBLIC_SUPABASE_URL` when set, else `SUPABASE_URL`; the JWKS is
  still fetched from `SUPABASE_URL`. Only `supabase/tests/functions.env` sets it. **Why:** locally the function reaches
  Supabase at `http://kong:8000` while tokens are issued for `http://127.0.0.1:54321`, so every user token was rejected.
  Production is unchanged (both URLs are the same there).
- **Done:** tests serve functions with `supabase/tests/functions.env` (dummy keys, committed). **Why:** `supabase/.env`
  has the real KIS/KRX keys; tests must not reach KIS, KRX or t.me. The MCP suite fails first if the wrong env is used.

## 2026-11-16 — Real API responses as test fixtures (gitignored)
- **Done:** `deno task fixtures` (`scripts/fetch_fixtures.ts`) saves one real response per source: KRX both markets for
  2026-11-13, a KIS `intstock-multprice` snapshot (30 stocks, mid-session), the `t.me/s/ehdwl` page. Parser tests run on
  them. **Why:** the seed is idealized; real data has 107 no-trade stocks, 96 alphanumeric 종목코드, 소속부 strings,
  KIS's empty rows for unknown codes.
- They confirmed the assumptions the code relies on: no-trade days have open/high/low = 0 with the close carried
  (in KIS too), 시가총액 = 종가 × 상장주식수 exactly, 등락률 matches 전일대비 (KRX rounds half away from zero), and KIS's
  previous close equals KRX's close.
- **Decided:** the fixture files are gitignored; their tests are skipped (not failed) without them, so a fresh clone and
  CI pass. **Why:** the repo is public, the Telegram page is a third party's posts, and KRX's terms don't allow passing
  the data on (see 2026-10-11). Trade-off: CI doesn't run those 18 tests, and only the KRX files can be fetched again
  identically; the KIS snapshot and the Telegram page are one-time, so a refetch means updating the values pinned in
  their tests. Keep a private copy of the `fixtures/` folders.

## 2026-11-16 — Ingest validation: refuse data that looks wrong
- **Done:** `krx-ingest` and `kis-ingest` check every batch before writing (`_shared/validate.ts`): row count (KRX
  ≥ 90% of the previous day, both markets present; KIS ≥ 95% of the stocks asked for), each field present, codes unique,
  OHLC in order, 등락률 within ±30%. More than 1% of rows (and more than 5) failing a check refuses the batch: nothing is
  written and the run returns 500 with the reason. **Why:** a format change doesn't throw in the parsers, it yields
  nulls or no rows. Before, a renamed KRX field would have stored the day with null prices and then deleted that day's
  KIS rows; a renamed block looked like a holiday.
- **Done:** Telegram: a page where fewer than 80% of the posts (counted from the `data-post` markers in the raw HTML)
  parse, or most posts are empty, is an error; so is an empty newest page for a channel that had posts. The channel then
  gets `last_error` / `poll_errors`. **Why:** the reader scrapes HTML; a renamed CSS class made it find nothing and
  record a successful poll, so a broken channel looked healthy.
- **Done:** refreshing stored Telegram posts never replaces their text with empty text. **Why:** a renamed text class
  would have wiped the stored text of every channel's newest posts on each poll (reproduced in a DB test before the fix).
- Expect after deploy: if KRX publishes KOSPI before KOSDAQ, `krx-ingest` returns 500 until both are out instead of
  storing half a day; the next run picks it up.

## 2026-11-16 — Benchmark (`deno task bench`)
- **Done:** `scripts/bench.ts` calls the read-only tools against production with the official MCP client and records
  client wall time (`total`), server time (`tool`) and `overhead` = total − tool. 50 calls per case in 5 rounds 60 s
  apart, after a warm-up; results in `bench-results/` (gitignored). Run it as `caffeinate -i deno task bench` (a Mac
  sleep mid-run skews the client-side numbers), after the market close so runs compare (during the session
  `analyze_stock` adds a live KIS quote and movers read the intraday day).
- **Decided:** arguments mirror real usage from `tool_calls.args` (no date where real calls omit it; feed with a 1 h and
  a 20 h `since`; search over 60 h), not invented ones; search terms are generic so other users' queries don't land in
  the public repo. **Why:** the first run's guesses took different code paths than real calls. 10 calls per case made
  p95 equal max; 50 makes it meaningful.
- Not covered: the write tools and the per-user feed path (the shared key has no user, so the feed reads all channels
  and never runs `user_channels` or the background refresh). Real calls' `timings` cover those.
- **Decided:** benchmark calls are not logged. The server recognizes the shared key plus a `krx-bench/` User-Agent,
  skips `tool_calls`, and returns `latency_ms` and the step timings in the result's `_meta` instead. A logged-in user is
  always logged. **Why:** test traffic in `tool_calls` would have to be filtered out of every query, and usage drives
  the go/no-go decisions. The first run's 110 logged rows were deleted. The script stops after one call if the deployed
  function doesn't return `_meta`.

## 2026-11-16 — Per-step timings (`tool_calls.timings`)
- **Done:** `tool_calls.timings jsonb`, e.g. `[{"step":"messages","start":760,"ms":681}, …]` (`start` = ms after the tool
  began, so parallel steps show as overlapping). `step('name', query)` in `mcp/timing.ts` records into the current call
  through `AsyncLocalStorage` (checked to work in the Edge runtime), so shared helpers record without a timer being
  passed around. Every DB and KIS call in the read tools is a step; `bg_stale_check` marks the background refresh.
  **Why:** `latency_ms` alone can't say which query is slow; the median per step is one query (see the migration).
- `pg_stat_statements` showed 0.5–1 s means for `available_dates` queries; they run in ~1.6 ms today. The means mix in
  the pre-11-13 view (742k-row count): `create or replace view` keeps the same statement entry.

## 2026-11-16 — Region forwarding (`DB_REGION`)
- Found with the step timings: every DB round trip took ~650–800 ms on real calls while the SQL ran in under 2 ms.
  **Why:** the database is in `ap-south-1` (Mumbai), and Edge Functions run in the region nearest the caller (Claude's
  servers, or Seoul for the benchmark), so every query crossed continents, plus connection setup on fresh copies.
- **Done:** `mcp` forwards a request that lands outside `DB_REGION` once to its own copy there (`x-region` header),
  which does the work next to the database and streams the answer back (`mcp/forward.ts`). The URL users have doesn't
  change; `DB_REGION=ap-south-1` is a secret (unset = off, as locally and in tests). Never loops: only a copy outside
  `DB_REGION` forwards (`SB_REGION`), and a forwarded request (`x-mcp-forwarded`) is never forwarded again. If the
  forward fails, the request is handled where it landed. Responses carry `x-mcp-handled-in`. **Why:** Supabase has no
  project-level region setting (only per request: header, `?forceFunctionRegion=`, client option), and a parameter in
  the connector URL means handing out new links.
- Results, hourly user's real calls (tool time): feed 1,510 → 517 ms, movers 2,131 → 209 ms. Benchmark from Seoul:
  per trip ~190 → ~45 ms; overhead ~45 → ~215 ms (the hop, once per call). Tools with 2–3 queries 25–45% faster
  end to end; single-query tools about even from Seoul (more gain from Claude's farther regions).
- Remaining cost: a fresh copy after idle (every hourly call): the first query ~150–700 ms (connection setup) and a
  cold hop (~1 s total for the first call after 60 s idle in the benchmark). The real crossing from Claude to Mumbai
  isn't measured anywhere (`latency_ms` starts inside the Mumbai copy).
- Ingest functions are unaffected: `pg_cron` calls them from the database, so they already run in Mumbai.
- README: CLI v3 `supabase db push` targets the local stack; the setup now says `supabase db push --remote`.

## 2026-11-16 — Telegram decisions
- **Decided:** drop the feed's background refresh (`refreshStale` / `bg_stale_check`), reversing 11-13. **Why:** it
  never makes the current answer fresher, `telegram-ingest` already polls every 5 minutes, it costs a query on every
  feed call, and it re-polls channels the cron backs off from after 3 errors. Not done yet (see Open).
- **Decided:** keep the backfill at 8 pages / 30 days, whichever comes first. A busy channel gets less history
  (insidertracking ~59 posts/day: 2.5 days). **Why:** older posts aren't important, and they would fill the database
  as channels are added.
- **Decided:** adding or following a new channel should answer after the first page (it proves the channel is public
  and holds the newest posts) and backfill the rest after the response. Needs a backfill status per channel, so the
  cron finishes an interrupted backfill (it only fetches newer posts otherwise, so a gap would stay) and feed/search can
  say a channel is still filling. **Why:** following a new channel took 8–21 s. Not done yet.
- `telegram_channels.active` only stops polling; stored posts stay readable. Nothing in the code sets it to false.

## 2026-11-17 — Fewer sequential queries in the MCP tools
- Checked first that parallel queries really overlap on Edge: in real feed calls `bg_stale_check` and `messages` started
  together at ~75 ms each, and the benchmark's three `check_available_dates` queries took 60/70/81 ms vs ~40 ms alone.
  Only the first query on a fresh copy pays connection setup.
- **Done:** the day's status comes from its `available_dates` row (`bas_dd, final, as_of`) instead of a separate
  `data_status` query after the main one. Movers and screen without a date read the latest row once (day + status);
  with a date, they fetch the row alongside the main query. A missing row means no data, which replaces movers'
  `day_count`. `check_available_dates` selects `final, as_of` with its date queries, so it has no status query left.
- **Done:** `screen_stocks` on a day without data (weekend, holiday) returns the same "No data for this date" error as
  movers. **Why:** it returned `count: 0` marked 확정치, which reads as "nothing matched"; the status row now shows it.
- **Done:** `analyze_stock` learns its day only from the history (a stock's latest row), so it fetches the provisional
  days (`final = false`, from `live_prices`, usually one) alongside; every other day is final. The live quote starts
  as soon as those show today has a snapshot, instead of after history and status. **Why not start it at once:**
  during the session it would call KIS even on days without a snapshot (tests use dummy keys and must not reach KIS).
- **Done:** Telegram tools start `latest_trading_day` first (`early()`, which keeps an un-awaited failure from becoming
  an unhandled rejection). In the feed, the user's channels and the trading day start together; with a channel, the
  posts are read alongside the existence check. Removed the background refresh (`refreshStale`, decided 11-16).
  `add_telegram_channel` follows the channel alongside its three reads.
- Trips on the common path: movers/screen 3 → 2, `check_available_dates` 2 → 1, analyze 2 → 1 (+ quote overlapped),
  feed 3–4 → 2–3, search 3 → 2. A test pins which steps overlap.
- Results (benchmark 10:12 vs 10:42 KST, both in session; tool p50): movers 119 → 79, `check_available_dates`
  116 → 77, screen 339 → 295, analyze 253 → 234. Real call: movers 136 → 90 ms. A removed query saves a full trip
  (~40 ms); running two side by side saves only ~20 ms, since each slows by ~15 ms (`history` 41 → 56 ms next to
  `provisional_days`). Analyze in session is mostly the KIS quote (131–1,779 ms). Client p95 totals are noise
  (unchanged tools moved by hundreds of ms); compare tool p50 and steps. Feed/search don't show it in the benchmark
  (shared key: no `user_channels`; the trading day is cached on the warm copy).
- Cold copy: queries started together all wait out the ~500 ms connection setup at once (three
  `check_available_dates` queries at 494/494/512 ms), so the call pays it once; parallelizing doesn't hide it.

## 2026-11-17 — KIS token: read early, keep in memory
- **Done:** in-session `analyze_stock` looks up the stored KIS token at time 0, alongside `history` and
  `provisional_days` (`storedKisToken`: memory, else one Postgres read; never calls KIS). A new token is issued only
  once the quote is known to be needed, as before. **Why:** `kis_token` was a 33–53 ms read between
  `provisional_days` and the quote on every in-session call.
- **Done:** the token is also kept in memory per function instance (`_shared/kis.ts`, same "10+ minutes left" rule), so a
  warm instance skips the read. **Why a memory cache alone wasn't enough:** the hourly user lands on a fresh instance
  almost every time, so the early read is what helps real calls.
- **Done:** if KIS rejects the token (EGW00121 / EGW00123 / 401), the quote drops the memory copy, re-reads Postgres and
  retries once, only with a different token (it never issues there, since KIS rate-limits issuance). **Why:** a memory
  copy can outlive a token another function replaced. Not verified whether KIS invalidates old tokens on re-issue.

## 2026-11-17 — Forward hop in `tool_calls`
- **Done:** `tool_calls.landed_in`, `forward_ms`, `handled_in`. The landing copy stamps when and where the request
  landed (`x-mcp-landed-at`, `x-mcp-landed-in`); the Mumbai copy computes `forward_ms` = arrival − stamp and logs it
  with the call. `handled_in` = `SB_REGION`, which also shows forwards that failed and were handled where they landed.
  Benchmark calls get the same three values in `_meta`. **Why:** `latency_ms` starts inside the Mumbai copy, so the
  crossing from Claude's region was not measured anywhere.
- **Decided:** one-way, in `tool_calls`, not a separate table timed by the landing copy. **Why:** the landing copy
  knows the round trip only after the answer has streamed back, so it would need its own row (or an update racing
  Mumbai's insert). One way is enough to judge the hop: the way back is similar, and the two hosts' clocks are
  NTP-synced (a few ms; a negative value would show skew). Not covered: the answer's streaming time, and Claude → the
  landing copy (short: it's the region nearest the caller).
- A caller can't put values in the log: `x-mcp-forward-ms` is always recomputed on arrival, and the landing headers
  are dropped unless the request carries the forwarded marker with a stamp within ±60 s.
- First real hop (12:00, `get_telegram_feed`): landed `us-east-1`, ran in `ap-south-1`, `forward_ms` 864 with a 398 ms
  tool, so more than half the wait came before the tool started. A one-way US East → Mumbai trip is ~100 ms, so most of
  it was likely start-up: the Mumbai instance was cold (first queries 164 / 355 ms), and the landing one probably too.
  On that cold instance the feed's early `latest_trading_day` took 355 ms against 164 ms for `user_channels` and
  became the critical path (398 ms vs ~313 ms in sequence); at 11:48 the two were even (507 / 510 ms). Watch more calls.
- Tried and dropped (`…000001` added, `…000002` drops them): cold/idle state of both instances per call
  (`landing_cold`, `landing_idle_ms`, `handled_cold`, `handled_idle_ms`). **Why dropped:** a cold start happens before
  our code runs, and lands on the MCP handshake (`initialize`, `tools/list`), which isn't logged; the tool call right
  after it shows as warm. In the 12:26 Samsung calls both instances were "warm" (idle 1 ms–11 s) while every first
  query still took 185–474 ms.
- Findings (12:02–12:26, 13 forwarded calls): `forward_ms` 138–864 ms with a floor of ~140 ms (one call per batch),
  most 500–860 ms, even from a warm landing instance. Unverified guess: a new connection across to Mumbai (TLS over
  a ~200 ms round trip) vs. a reused one. Three tool calls Claude sent at once ran on one Mumbai instance, and all
  seven first queries were slow, each by a different amount: queries in flight together each open their own connection.
- The slow first queries aren't Postgres: `pg_stat_statements` max execution time is 4.8 ms for `user_channels`
  (68 calls) and 22 ms for `kis_token` (1,158 calls), against 316–507 ms seen on new instances. The time is on the
  way from the instance to the database API (connection setup), not a cold database cache.
- Deploy order: `supabase db push --remote` before `supabase functions deploy mcp`; otherwise the `tool_calls` insert
  fails on the unknown columns (logged to console only; tools keep working).

## 2026-11-17 — Handshake answered where it lands
- **Done:** the landing copy forwards only requests that may run a tool. It reads the JSON-RPC method from the body it
  already buffers (`needsDbRegion` in `forward.ts`): `initialize`, `tools/list`, `ping` and `notifications/*` are
  answered locally, and so are requests without a JSON-RPC call (GET/DELETE, OAuth metadata, a 401). Everything else,
  `tools/call` or a method added later, is forwarded; a batch goes if any message needs it. **Why:** every request was
  forwarded, so a session's start (`initialize`, `initialized`, `tools/list`) paid a hop of ~140–860 ms each before
  the first tool call. The handler is stateless (`createMcpHandler`: a fresh server per request) and those methods
  never touch the database, so answering them where they land changes nothing but the wait.
- Locally answered responses carry `x-mcp-handled-in` like forwarded ones, to check where each request ran.
- Trade-offs: the landing copy now verifies login tokens for those requests, fetching the JWKS once per instance
  from across the ocean (then cached). The Mumbai instance's cold start moves from the handshake onto the first tool
  call; the user waited through it before as well.

## 2026-11-17 — Why the first query is slow: new workers (idle experiment)
- Experiment (13:06–13:57 KST, 37 read-only unlogged calls straight to Mumbai via `x-region`, worker identified by
  `x-deno-execution-id`): a slow first query (381–640 ms) comes with a new worker; a reused worker's first query is
  51–79 ms even after idling. A new worker also takes ~314–383 ms to start (gateway `x-envoy-upstream-service-time`).
  Reuse by actual idle time: 5–20 s 6/6, 30–61 s 2/4, 90 s and more 0/8 (incl. 11 and 21 min; the Mac slept through
  two planned waits, so idle times come from timestamps).
- Not Postgres (< 5 ms in `pg_stat_statements`), not a cold cache: the cost is opening connections from a new worker
  to the database API, each query in flight opening its own. Which part (DNS, TCP, TLS, gateway) is unknown; not
  pursued, since no change of ours depends on it.
- Supabase docs: on the free plan a worker lives at most 150 s and may be retired earlier when idle ("EarlyDrop"), so
  hourly calls always get a new worker. Write-up with diagrams: `docs/network.pdf`.
- Claude's calls land in `us-east-1` because the MCP request comes from Anthropic's servers, not the user's device;
  Cloudflare in front of Supabase can't cache MCP answers (POST, per-user, live data: `cf-cache-status: DYNAMIC`).

## 2026-11-17 — Benchmark: `--region` and forward
- **Done:** `deno task bench --region us-east-1` sends `x-region`, so calls land where Claude's do and are forwarded
  from there; the report adds `fwd` (`forward_ms`). **Why:** from Seoul the forward wasn't Claude's. tool and fwd are
  comparable to real calls; total isn't (it includes Seoul ↔ US), and a run's spacing decides whether workers are new
  (back-to-back: warm; a round's first call after a long pause: new). All-cold run (every call on new workers; 150 s
  is the free plan's worker lifetime): `deno task bench --region us-east-1 --only get_stock_history --n 5 --rounds 5
  --pause 150`.
- Tried and dropped: per-worker ids and request counts, the gateway's `x-envoy-upstream-service-time`, a
  `rest` column (total − tool − fwd), a keep-warm ping script and a connection probe function. **Why:** none answered a
  question that changes a decision; the first query's time and `fwd` show what matters.
- Sparse baseline (5 calls, 120 s apart, landing in `us-east-1`): 4 of 5 slow (first query 443–561 ms, `fwd`
  580–1,001 ms); one fast (96 ms, 113 ms), on a worker that survived 120 s idle.

## 2026-11-17 — Real calls confirm the query changes
- Feed (11:48, 12:00, 12:26, 13:47, 14:48, 15:49): `user_channels` and `latest_trading_day` start together, no
  `bg_stale_check`; on a new worker either one can be the slower and set the pace.
- `analyze_stock` in session (12:26): `kis_token` starts at 0 and the KIS quote right after it; off session (16:04):
  `history` and `provisional_days` start together, no KIS call. Off-session warm (benchmark, 16:10, 5 calls): tool
  p50 85 ms (`provisional_days` 75 ∥ `history` 84), no gain over 11-16's ~78 ms in sequence, because `history` alone
  was 84 ms against ~43 then. Cause unknown (5 calls, right after the 16:00 ingest rewrite); not pursued.

## 2026-11-17 — Cold calls accepted for now; CI
- **Decided:** accept the cold-call cost (~0.8–1 s more when the workers are new: start-up plus opening connections,
  mostly in Mumbai) and drop the keep-warm and region-move work. **Why:** usage is one scheduled routine and a few
  live sessions, and Claude spends several seconds generating each answer anyway. Revisit if users find it slow:
  the options are a keep-warm ping (test with the sparse benchmark run) or moving the project to `us-east-1`.
- Dropped from Open with it: why `kis-ingest`'s previous-day lookup averages ~1 s in `pg_stat_statements` (may still
  include the pre-11-13 view) and whether ingest runs slow real calls (one sample: first queries 1.5–2 s at 16:04
  during the 16:00 run, 518–726 ms at 16:09 without).
- **Done:** CI (`.github/workflows/test.yml`): `deno task check` (typecheck of every function and script, including
  the `index.ts` files no unit test imports) and `deno task test` on every push and pull request, Deno pinned to
  2.9.8. No secrets; the fixture tests are skipped there (66 pass, 28 skipped in a fresh clone). The DB and MCP suites
  still need the local stack.

## 2026-11-17 — `tool_calls.client` restored for forwarded calls
- **Done:** since region forwarding (11-16 16:18) the runtime appended its own User-Agent to the forwarded request
  (`Claude-User (variant; SupabaseEdgeRuntime/1.79.1; ref=<project ref>)`), so one client was logged under two names,
  with the project ref in every row. The landing copy now carries the caller's User-Agent in `x-mcp-client` (dropped
  from direct requests, like the other forward headers) and the handling copy logs that. Migration
  `20261117000003` restores the 57 affected rows to `Claude-User`. The benchmark exclusion (`krx-bench/` prefix) was
  never affected.

## 2026-11-17 — `supabase config push` under CLI v3; usage view dropped
- Checked: `config push` is remote-only in CLI v3 (always the linked production project, with a confirmation prompt)
  and writes every setting `config.toml` declares in api/auth/database/pooler/realtime/storage. `config diff` against
  production today: 17 differences, all settings `config.toml` doesn't declare (auth URLs, Google login, the OAuth
  server, pooler sizes), so a push would change nothing. Functions aren't in its scope at all: `verify_jwt = false`
  comes from `[functions.*]` in `config.toml` at `functions deploy` (all four deployed functions show it).
- **Done:** README setup no longer runs `config push` (it claimed to set `verify_jwt`); it says where `verify_jwt` comes
  from, and to run `config diff` first if `config push` is ever used.
- **Decided:** no `user_activity` view for now; usage is checked with plain SQL. Revisit if that gets tedious.

## 2026-11-17 — Edge cases for `screen_stocks` vs. `analyze()`; rounding fix
- **Decided:** no comparison on production data. Both sides are deterministic math on the same rows, already compared
  on purpose-built seeded stocks; real data could only add edge cases, and a disagreement would be a slightly different
  number between a screen and `analyze_stock`. The likely edge cases went into the seed instead.
- **Done:** three seeded stocks (`supabase/seed.sql`), compared by the existing test like the others: 900010 반올림전자
  (last-day 거래대금/거래량 exactly 1.005× the average: a rounding boundary), 900011 동률화학 (last close equal to the
  prior 20/60/120-day high: a tie is not a breakout), 900012 휴업물산 (halted 5 days inside the windows, then trading).
- Found and fixed: `analyze()` rounded 1.005 to 1.00 where `screen_stocks` gave 1.01. `round()` used
  `Math.round(v * 100) / 100`, and 1.005 is stored as 1.00499999…; it also rounded negative halves toward zero. It now
  rounds on 15 significant digits, halves away from zero, like Postgres `round(numeric)` (unit tests in
  `analyze_test.ts`). The tie and the halted stock already agreed.

## 2026-11-17 — Latency so far (summary)
- **Region forwarding was the big one** (11-16): tool calls run next to the database, so each query is ~40–75 ms
  instead of ~700 ms. Real feed tool time 1,510 → 517 ms, movers 2,131 → 209 ms. Its follow-ups: answering the
  handshake where it lands (saves 2–3 hops of ~140–860 ms per session start) and `forward_ms` in `tool_calls`.
- **Fewer sequential queries helped a little:** a removed query saves a full trip (~40 ms: benchmark movers 119 → 79,
  `check_available_dates` 116 → 77, screen 339 → 295; real movers 136 → 90); two queries side by side save only
  ~20 ms (each slows ~15 ms). Off-session `analyze_stock` showed no gain.
- **Largest remaining cost: cold calls**, parked by decision: a new worker costs ~0.8–1 s (start-up ~350 ms inside
  `forward_ms`, ~300–550 ms per connection it opens). Claude's occasional calls mostly hit new workers: ~1.2–1.6 s on
  the server side cold vs ~0.3–0.5 s warm.
- **Query speed itself is mostly not the bottleneck:** most queries run in ~1.5–7 ms in Postgres, so 85–95% of a warm
  query is the trip to the database API. Exceptions: `screen_stocks` (~250 ms of real SQL work; one real call 1,445 ms)
  and the live KIS quote in in-session `analyze_stock` (130 ms–1.8 s, external).
- Remaining levers, by size: cold calls (~0.8–1 s, parked) · the KIS quote (up to ~1.8 s, see below) ·
  `screen_stocks` SQL (~0.25–1.4 s) · fewer trips (~40 ms each, e.g. one SQL function for day + main query) · faster
  SQL elsewhere (a few ms). Claude generating its answer (seconds per turn) dwarfs all of them.
- The benchmark runs behind these numbers (`bench-results/`, gitignored: keep a copy):
  `20261116T065433Z-before-forwarding`, `20261116T075114Z-after-forwarding`, `20261117T011225Z-before-parallel`,
  `20261117T014213Z-after-parallel`. Both pairs are from Seoul, without `--region` (it didn't exist yet).

## 2026-11-17 — KIS quote: record rate-limit waits
- Kept: the live quote in in-session `analyze_stock` (the current price should be as fresh as possible; the snapshot
  can be 5 minutes old). The token is cached; the time is the quote request itself.
- **Done:** `kisGet` takes an `onRateLimited` callback, and the quote records each wait after KIS's per-second limit
  (`EGW00201`, then a 1 s sleep and a retry) as a `kis_rate_limited` step inside `kis_quote`. No schema change
  (`timings` is JSON). **Why:** the limit is per app key and `kis-ingest` sends ~93 requests in a burst every 5 minutes,
  so the slow quotes (1.2–1.8 s) may be collisions with it; the timings couldn't tell.

## 2026-11-18 — Ingest run record, failure alerts, daily report
- **Done:** `ingest_runs`: every run of `krx-ingest`, `kis-ingest` and `telegram-ingest` records itself (job, time,
  ok, HTTP status, its answer, the error), through one wrapper (`monitored()` in `_shared/ops.ts`). **Why:** pg_cron
  only starts the HTTP request, so `cron.job_run_details` says "succeeded" even when a function refuses a batch, and
  `net._http_response` keeps the answer only a few hours: a failure was visible to nobody (the 11-13 KRX key expiry
  went two weeks unnoticed).
- **Done:** a failed run sends an immediate Telegram message to the operator, at most one per job per hour
  (`alerted`), so a broken key doesn't send one every 5 minutes.
- **Done:** `pipeline-report`, daily at 18:00 KST (pg_cron), sends a Telegram report of the 24 hours before 18:00
  (yesterday's 18:00 KIS run through today's runs; today's 18:00 run is in tomorrow's report): today's KIS snapshots
  (and whether one came after the 15:40 close), the latest KRX day, Telegram polls and new posts, failing channels,
  and failed runs per job. Weekends and holidays get a short "market closed" report. No message at 18:00 means the
  report itself failed. It also deletes runs older than 90 days.
- KRX check without a holiday calendar: `krx-ingest` deletes a day's `live_prices` rows once KRX's data is in, so a
  provisional day before today still there at 18:00 is one KRX hasn't loaded; holidays never get KIS rows. A weekday
  is a holiday when `kis-ingest` reported "not a trading day".
- Secrets `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (README → Secrets); the cron job is in `sql/cron.example.sql`.
- **Done:** KIS vs. KRX check. Before `krx-ingest` replaces a day's KIS rows with KRX's official data, it compares the
  closes (`compareKisKrx`, answer field `kis_check`: compared, mismatches, stocks on one side only, examples), and the
  report shows `✅ KIS vs KRX 11-16: all 2,771 closes match` or `⚠️ … N of M closes differ (examples)`. **Why:** the
  KIS/KRX agreement was checked once on the 11-16 fixtures; this checks it every day. Closes only: after-hours trading
  changes 거래량/거래대금 legitimately. Unverified: whether KIS's 18:00 snapshot close can differ from KRX's close
  (after-hours single-price trading); the first reports will show.
- Tests: unit tests for the error extraction, the report text and `compareKisKrx`; DB tests for `monitored()` on the
  local stack (a run is recorded with its answer, a 401 isn't, a failure alerts once per hour and again after it,
  a thrown error is a failed run, no secrets = recorded but not alerted; Telegram's API stubbed).
- **Done:** Telegram channel alerts only on change: a channel that starts failing (healthy before this run) or works
  again (`telegram-ingest/alerts.ts`). **Why:** failing channels are retried hourly and each retry fails the run, so a
  permanently broken channel would have alerted every hour; it now alerts once, and the 18:00 report keeps listing it.
  A failure of the whole run (no per-channel results) still gets the hourly-throttled alert (`monitored`'s `alertOn`).
- **Decided:** CI keeps skipping the real-data parser tests (fixtures are gitignored: KRX's terms and third-party
  posts in a public repo). A parser only changes with its code, and those tests run locally then; a source changing
  its format is caught by the ingest validation, which now alerts.

## Open
- Telegram background backfill with a status column, cron resume, and a "still collecting" note in feed/search (8-page
  cap kept).
- Telegram tagging matches only 6-digit codes, so the 96 alphanumeric 종목코드 can be tagged by name only.
- After a day of in-session `analyze_stock` calls: check `kis_rate_limited` steps. If slow quotes are rate-limit waits,
  shorten the quote's backoff (one request needs little of the per-second budget), pace `kis-ingest`'s burst, or use
  a separate KIS app key for quotes.
