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

## 2026-11-18 — Requirements baseline
- **Done:** `docs/requirements.md`: functional requirements mapped to their tests, and non-functional targets
  (latency by tier, response size, reliability, freshness, ingest runtime, correctness, free-plan capacity, security)
  with IDs and baselines. **Why:** a fixed bar to check changes against, instead of judging each benchmark by eye.
- Baselines from production `tool_calls` / `ingest_runs` (11-13 to 11-18) and `bench-results/` (11-17). Samples are
  small (1–35 calls per tool since the 11-17 changes); re-baseline after a month.
- Cold latency gets its own targets (PERF-7, PERF-9–11): occasional calls, which is most real usage, always start new
  workers, and the warm benchmark hides that.
- **Done:** `scripts/bench_cold.ts` (`deno task bench:cold`), separate from the warm `bench.ts` (shared cases and
  client in `bench_shared.ts`). It waits 150 s before every call, the first included, round-robin over the cases.
  **Why:** `bench.ts --pause 150` started round 1 right after the warm-up, so its first scored call was warm, and its
  cases run back to back, so only one case per run was cold.
- **Done:** each cold run writes `<run id>-cold.sql`: per case, cold p50/p95 with every call dropped that had a real
  `tool_call` in the 150 s before it. **Why:** production keeps serving real calls during the run, and the worker
  next to the database serves all of them; the benchmark can't query the database itself (shared key only).

## 2026-11-18 — Telegram background backfill
- **Done:** adding a channel (`add_telegram_channel`, and `set_/update_my_channels` for channels not collected yet)
  stores only the newest page and answers; the rest of the history (8 pages / 30 days, whichever first, as decided
  11-16) is fetched after the response (`backfillChannel` in `_shared/telegram.ts`, via `EdgeRuntime.waitUntil`).
  Several new channels are backfilled one after another, not in parallel. **Why:** following a new channel took
  8–21 s, almost all of it the backfill's pages (~0.8 s pause + fetch each); the first page alone proves the channel is
  public and holds the newest posts.
- The page fetched for the public-preview check is reused as the first page (`syncChannel`'s `firstPage`), so a new
  channel costs one t.me request before the answer, not two.
- Progress lives on the channel (`backfill_before`, `backfill_oldest_ts`, `backfill_since`, `backfill_pages`,
  `backfill_at`; migration `20261118000001`) and is saved after every page. `telegram-ingest` resumes a backfill with
  no progress for 3 minutes (its worker ended: free-plan workers live at most 150 s), claiming it first so it never
  runs alongside a background backfill that is still going. Only for channels whose poll works; a failed page counts
  towards the 8-page cap, so retries end. Backfill results go into the run's answer (`backfills`), not its status: a
  broken channel already fails its own poll.
- **Done:** `get_telegram_feed` and `search_telegram` add `still_collecting` (channel, time collected from) and a note
  when a channel in scope is still backfilling *and* the requested window starts before its oldest stored post; a
  window inside what's stored gets no note. One more query, run alongside the posts query. `list_telegram_channels`
  and `get_my_channels` show `collecting_older_posts`.
- Reactivating an inactive channel still catches up in the request (up to 8 pages of newer posts: a gap, not a
  backfill). Nothing sets `active = false` yet.
- Tests: DB tests run the real sync and backfill against a fake 200-post channel (first page only, the 8-page cap,
  stopping at the 30-day mark, no backfill when the first page reaches it, the resume claim, a failing page); an MCP
  test for when the note appears. Not tested: the `waitUntil` hand-off itself (needs a real t.me channel on the
  deployed function).

- **Checked in production** (11:52 KST, `HANAStrategy`): `add_telegram_channel` took 1,991 ms on the server (+390 ms
  forward from us-east-1), against 13.6–21.6 s before; PERF-3 (≤ 5 s) met, n=1. From the row timestamps: ~1.3 s
  lookup, count, t.me page and insert; ~0.4 s storing the page; ~0.3 s follow and reading back; ~300 ms of it the new
  worker's first database connection (`latest_trading_day` 296 ms). The background backfill fetched 3 more pages
  (4 in all) and finished 5 s after the add, stopping at the 30-day mark (73 posts); no resume needed.
- **Done:** the add path records its steps (`channel_lookup`, `channel_count`, `tg_fetch_page`, `channel_insert`,
  `channel_reactivate`, `tg_sync`, then `follow` ∥ `channel_title` ∥ `posts_count` ∥ `latest_posts`), so the next add
  shows the split in `tool_calls.timings` instead of being reconstructed from timestamps. `set_/update_my_channels`
  get the same steps through `ensureChannel`.

## 2026-11-18 — Stopped runs, KIS timings, readable errors
- **Found:** at 12:00 KST telegram-ingest alerted `insidertracking` failing with raw HTML: a Cloudflare 520 from
  `supabase.co` (the gateway in front of the database API) while upserting posts; that run took 56 s against ~5 s.
  Around it, kis-ingest slowed: ~27 s per run as usual, but 68 s (10:00), 129 s (11:15), 135 s (11:50), then the
  11:55 and 12:00 runs stopped at 150 s (`net._http_response`: `timed_out`). Those two left no `ingest_runs` row and
  sent no alert: the run records itself, and a stopped run never gets that far; `cron.job_run_details` says
  "succeeded" (it only sent the request). Postgres wasn't slow (`pg_stat_statements` tops are one-off maintenance), so
  the time went to the API gateway or to KIS (rate-limit back-off); kis-ingest recorded no timings to tell. Not
  confirmed: the free plan's disk IO budget (Dashboard → Reports → Database).
- **Done:** `monitored()` writes the `ingest_runs` row when a run starts (`ok = null`: running) and completes it at the
  end; a handler saves progress into it (`run.progress`). A row still running 180 s after it started was stopped:
  the next monitored run of any job (telegram-ingest, every 5 minutes) marks it failed (`KILLED_ERROR`) and alerts
  with its last progress, within the job's hourly throttle (`sweepKilled`; the conditional update marks and alerts
  each stopped run once, even with two functions sweeping at once). Migration `20261118000002` makes `ok` nullable.
  **Why:** a run stopped at the time limit was invisible. Reading `net._http_response` instead wasn't an option: it
  doesn't store the URL, and two jobs start in the same second.
- **Done:** kis-ingest's answer carries `timings`: token, latest day, stock list, KIS calls (count, total, slowest),
  rate-limit answers and their waits, the upsert; the same numbers go into the running row every 25 KIS calls and
  before the upsert, so a stopped run shows its phase.
- **Done:** `readableError` (`_shared/errors.ts`): an HTML error page in an error message is replaced by its
  `<title>` (`update posts: HTML error page (supabase.co | 520: …)`), in `ingest_runs.error`, the alerts and
  Telegram's `last_error`.
- The daily report counts only `ok = false` as failed (a running row isn't a failure).

## 2026-11-18 — KIS slowdown cause; feed shared across channels
- **Found:** with the timings deployed, the slow kis-ingest runs are slow KIS calls, not rate limits or the database.
  12:15 KST: 84.8 s, of which the 93 multprice calls 72.3 s (avg 778 ms, slowest 2.1 s); 12:20: 115.3 s, calls
  103.1 s (avg 1.1 s, slowest 2.7 s). Both: 0 rate-limit answers, upsert 268 ms, stock list < 0.3 s, token < 0.1 s.
  A normal ~27 s run is ~9.3 s of the 100 ms pauses plus ~0.16 s per call, so each call got 5–7× slower. Whether
  that's KIS's servers or the path from Mumbai to Korea isn't told apart; `analyze_stock`'s slow quotes (1.2–1.8 s,
  11-17) point at KIS. The 12:00 Cloudflare 520 on the Telegram upsert was a separate, one-off gateway error.
- **Done:** `get_telegram_feed` shares its `limit` across channels (round-robin: each channel's posts numbered newest
  first, the lowest numbers taken), in one SQL function (`telegram_feed`, migration `20261118000003`). With the
  default window (no `since`), today's posts (KST) are shared first and earlier days fill what's left. The answer
  adds `channels` (shown, shown_today, today, in_window per channel) and a `channels_note` when a channel has more
  than shown. **Why:** the default feed was 20 of 20 from insidertracking (114 posts a day against 1–5 for the four
  others), and Claude was working around it with one call per channel. On 11-18 data the new default is 11
  insidertracking + all of today's posts of the other four (5, 2, 1, 1). An explicit `since` spreads the slots over
  the whole period instead, so a week-long question isn't mostly today.

## 2026-11-18 — kis-ingest: calls in parallel, run in Seoul
- **Done:** the 93 multprice calls run 5 at a time under 10 starts per second (`kis-ingest/pool.ts`), instead of one
  after another with a 100 ms pause. **Why:** a run took 93 × KIS's response time, so ~1.1 s calls made it ~115 s, and
  two runs hit the 150 s limit. Now bounded by the cap (~9.3 s) or by 93 × latency / 5 (~20 s at 1.1 s). 10/s is half
  of KIS's 20/s per-app-key limit, which `analyze_stock`'s live quotes share; a rate-limited call still backs off
  1 s and retries (`kisGet`). `timings` adds `kis_wall_ms` (the phase's wall time; `kis_ms` is now the calls added
  up) and `ran_in`.
- **Done:** the kis-ingest cron jobs send `x-region: ap-northeast-2` (`sql/cron.example.sql`), so the function runs in
  Seoul next to KIS instead of Mumbai next to the database: 93 KIS round trips become local, and the few database
  calls (token, latest day, stock list, 3 upserts of ≤ 1,000 rows) cross instead. **Why:** a normal call was ~0.16 s
  from Mumbai; whether 11-18's ~1 s calls were KIS's servers or the path, Seoul removes the path. Unverified until it
  runs: whether Supabase honors `x-region` on requests from pg_net (`ran_in` will tell).

## 2026-11-18 — First cold benchmark
- Three `bench:cold` runs (one tool each, 5 calls 150 s apart, landing in us-east-1, from Seoul): find_stock,
  check_available_dates, get_daily_movers. One call dropped (a real call 58 s before it). Numbers in requirements
  §2.3.
- Cold end-to-end p50 is 2.4–2.9 s against ~0.3 s warm (11-17): the cold penalty is +2.1–2.6 s per call. Of it,
  server `tool` ~0.5–0.6 s (warm ~0.08 s: the new worker's first database connections) and `fwd` ~0.7–1.0 s (warm
  ~0.1 s: the Mumbai worker starting). The rest (total − tool − fwd at p50: ~1.0–1.7 s against ~0.1 s warm) is
  outside what the server measures: the us-east-1 worker starting, plus new connections from the benchmark machine
  after 150 s idle (the last part isn't what Claude's servers pay).
- Server-side targets hold (PERF-9: tool p95 572–770 ms); end to end, 2 of 3 tools are over the 3 s p95 (PERF-7),
  and the cold penalty is over its 1.5 s target for all three (PERF-11). The worst samples (check_available_dates
  4.7 s, fwd 3.2 s) were at 12:00 KST, during the gateway slowdown.
- This is the cost parked on 11-17 ("Cold calls accepted for now"). The options stand: a keep-warm ping, or moving
  the project to us-east-1 (removes the forward hop and puts the database next to Claude's calls).

## 2026-11-18 — kis-ingest in Seoul: first runs, network errors
- Seoul works: from 12:45 KST every run has `ran_in: ap-northeast-2`; runs take 15.7–22.3 s (against 29–115 s from
  Mumbai today), the KIS phase 9.2–12.0 s (bounded by the 10/s cap). The database steps got slower from Seoul (stock
  list ~2 s, upsert ~2.7 s, against ~0.2–0.3 s each), well worth it.
- **Found:** the 13:20 and 13:25 runs failed on one KIS request each that got no answer at all (Deno: "error sending
  request from 10.32.33.59:… for https://openapi.koreainvestment.com:9443/…"), after 15 and 83 of 93 calls. No retry
  for that, so one failed call failed the snapshot (the previous one stayed). The cause was cut off: Deno's message
  starts with the full URL (~1,000 characters of stock codes), and ingest_runs keeps 1,000 characters. Rate-limit
  answers ran at 4–15 per run at 10/s (the old one-at-a-time code saw 0–1).
- **Done:** `kisGet` retries a request that got no answer twice (after 0.5 s, then 1 s; read-only GETs, so safe), and
  its final error names the call and the cause without the query string. **Why:** the usual cause of this error is a
  pooled keep-alive connection the server already closed, which a retry replaces; parallel calls keep more of them.
  `timings.network_retries` counts them. `analyze_stock`'s quotes get the same retries.
- **Done:** `readableError` drops URLs' query strings, so the cause after a long URL survives in alerts and
  `ingest_runs.error`.
- **Done:** KIS pace 10/s → 8/s (KIS phase ~11.6 s), for fewer rate-limit answers and more room for live quotes.

## 2026-11-18 — krx-ingest: timings, markets in parallel, run in Seoul
- **Found:** today's krx-ingest runs took 20, 27 and 18 s when KRX hadn't published (2–4 KRX calls returning nothing,
  no writes: ~5 s per call) and 126 s when it loaded 11-17 (2,771 rows), 24 s from the 150 s limit (ING-1).
  `pg_stat_statements` puts a 1,000-row `daily_prices` upsert at 310 ms mean (3.3 s max), so the 3 upserts explain
  at most ~10 s: the rest is the KRX calls (two full-day answers) from Mumbai to `data-dbg.krx.co.kr` in Korea.
  Inferred: the function recorded no timings.
- **Done:** krx-ingest's answer carries `timings`: `ran_in`, and per day each KRX call's ms, KB and rows, the two
  calls' wall time, the KIS comparison read, the upsert and the cleanup; saved into the running row after each day.
  KOSPI and KOSDAQ are fetched in parallel. Its cron job sends `x-region: ap-northeast-2`, like kis-ingest's.
- Not tested end to end locally (needs KRX); the parsers' tests pass. The next morning's runs (07:00–08:30) will show.

## 2026-11-18 — Telegram tagging: nicknames, codes with letters
- **Found:** 640 of 720 stored posts have no stock tag, but sampling them shows mostly foreign companies (엔비디아,
  모건스탠리), macro, crypto and general news, not missed KRX stocks. Nicknames are rare in these channels (삼전 1 post,
  LG엔솔 1; 하닉, 엘엔솔, 현차, 삼바, 셀트, 카뱅 0); 하이닉스 appears in 58 posts but only 1 lacked the SK하이닉스 tag.
- **Done:** `STOCK_ALIASES` in `_shared/telegram.ts`: 15 hand-picked nicknames for large caps (삼전, 하닉, 하이닉스,
  엘엔솔/엘지엔솔/LG엔솔, 현차, 기아차, 삼바, 셀트, 카뱅, 한화에어로, 에코비엠, 두산에너빌, 네이버), codes checked
  against the stock list. Matched like names (whole words, longest first) and allowed under 3 characters; one whose
  code isn't listed is ignored. 포스코 left out (several POSCO companies). A list in code, not a table: a handful.
- **Done:** codes with a letter (96 listed, e.g. 0001A0, 00088K) are tagged like 6-digit ones: any 6-character
  token of digits and capitals that is a listed code.
- Foreign stocks (엔비디아 → NVDA) stay untagged: the bigger gap, but a separate list and a decision on `stock=`.
- Existing posts need `telegram-ingest?retag=1` after deploying (~3 posts mention a nickname; none a lettered code).

## 2026-11-18 — Cold benchmark, all 10 cases
- `bench:cold` for the other 7 cases (13:00–14:27 KST, in session, 5 calls each; 1 dropped). All 10 cases are now in
  requirements §2.3. Every tool pays +2.2–3.5 s cold against warm p50: end-to-end p50 2.5–4.0 s cold vs 0.25–0.53 s
  warm. PERF-7 (cold p95 ≤ 3 s / 4 s) fails for 8 of 10; server-side PERF-9 holds except screen_stocks (2,511 ms).
- Per step: a new Mumbai worker's first database queries take 0.3–1.2 s (connection setup; parallel first queries all
  wait it out together, e.g. the 20h feed's three at ~1 s), the forward hop 0.6–1.1 s (up to 2.9 s), and the rest is
  the us-east-1 worker plus the benchmark machine's own connections.
- Two tool-specific costs on top: `analyze_stock`'s live KIS quote (0.74–1.18 s from Mumbai, in session), and
  `screen_stocks`' SQL itself (1.33–1.88 s cold against ~0.25 s warm), which looks like a cold database cache rather
  than connection setup (its first query, `latest_date`, already paid that). Not checked.

## 2026-11-18 — Re-scoped: self-hosted, personal use or a small closed group
- **Decided:** the project is a self-hosted tool for its operator and a small closed group (currently 2 people), not a
  service handed to PBs or listed publicly. **Why:** KRX's and KIS's terms are written for personal use and restrict
  passing data on to third parties, and redistributing Telegram posts to professionals is the riskiest part. A closed
  group is still a grey area under those terms (low risk because it stays small and private); the README says the
  operator is responsible for them. Checked: no data or keys in the git history (the committed `sql/cron.sql` only
  ever had placeholders).
- **Done:** `ALLOWED_USERS` (`mcp/allow.ts`): after the token is verified, only listed user ids or emails get in; any
  other login gets a 403, and an unset list lets nobody in (fails closed). **Why:** `mcp` accepted any valid Supabase
  login, so whoever could sign in with Google had full access unless sign-ups were off in the dashboard. Backed up by
  Google's consent screen in Testing with listed test users, and Supabase sign-ups off (README → Login).
- The `?key=` URL is now the operator's key for scripts and benchmarks, not a transition.
- **Decided:** rotate `MCP_ACCESS_KEY`, so the key is the operator's alone.
- README: a "Scope & data" section; `docs/plan.md`: a re-scope note on top, history kept; tool descriptions say "this
  deployment" instead of "all users". The per-user features stay: they're what a small group needs.

## 2026-11-18 — Dependencies pinned, lock file frozen
- **Done:** every import names an exact version: supabase-js 2.119.0, @modelcontextprotocol/server 2.4.0, zod 4.6.7,
  jose 5.10.0, @std/assert 1.0.19, and `jsr:@supabase/functions-js@2.119.0/edge-runtime.d.ts` (it had no version at
  all), the versions they resolved to on 11-18. `deno.json` turns the lock file on and freezes it (`deno.lock`,
  committed): `deno task check`/`test` (and CI) fail if anything would resolve differently. **Why:** with `^` ranges
  and no lock, each deploy took whatever was newest, and the functions run with the service-role key (jose verifies
  login tokens); a compromised or broken release would have gone straight to production.
- To update one: change its version in the imports, run a check with `--frozen=false` to rewrite `deno.lock`, run the
  tests, commit both.

## 2026-11-19 — 수능 day: auction prices, after-market, KIS and KRX kept apart
- **Found:** kis-ingest failed from 09:30 to 10:00 ("refused snapshot: open/close outside low..high in 94 of 2771
  rows", then 248, 315, 193), fine before and after. 11-19 was 수능 day, when KRX opens at 10:00: 09:30–10:00 was the
  pre-open auction, and KIS reports the day as today then, with the expected price (예상체결가) as the current price
  and high/low still empty. The check refused the snapshots as it should; the previous one stayed. The 09:05–09:25
  runs passed because nothing had traded yet (the range check only looks at traded rows), so they stored a flat,
  zero-volume "today". The same happens on the year's first trading day (also a 10:00 open).
- **Found:** the "KIS vs KRX" report line (2,080 of 2,770 closes differ on 11-17, 2,119 on 11-18) compared KIS's last
  snapshot, taken during the after-market, with KRX's 종가. Since 2026-09-14 KRX runs a continuous after-market from
  16:00 to 20:00 (replacing 시간외 단일가), so the two are expected to differ: not a data problem.
- **Decided:** KRX data goes only to `daily_prices`, KIS data only to `live_prices`, and `live_prices.close` is the
  latest price, after-market and expected prices included (no new columns). The `prices` view already shows KRX's
  rows for a day once it has them, and KIS's while KRX is late, so a late KRX keeps KIS's closes as provisional bars.
  **Why:** users want the latest price, including after hours; the official close is KRX's.
- **Done:** kis-ingest reads KIS's `hour_cls_code` (0 예상체결 없음, B 정규장전, A 정규장후, C 장중 예상체결). A run where
  more than half the stocks are at `B` is skipped (`skipped: pre-open auction`): pre-market data isn't kept. `A` and
  `C` rows (after the close, VI) are stored and left out of the low..high check. A refused snapshot's message now
  names 3 sample rows (`code o h l c`), so an alert can be diagnosed from the message.
- **Done:** removed the KIS vs KRX comparison (krx-ingest's `kis_check`, `compareKisKrx`, the report line) and
  krx-ingest's delete of the day's `live_prices` rows. pipeline-report deletes `live_prices` days older than 10 days
  instead (after the 18:00 report). **Why:** after-hours prices are supposed to differ from the 종가; keeping KIS's
  days a while covers a KRX outage of a week.
- **Done:** `kis-ingest-after-hours` runs at 17:05, 18:05, 19:05 and 20:05 KST (`5 8-11 * * 1-5`; was 16:00 and 18:00),
  so the day ends on the after-market's last price. Applied with `cron.alter_job`; `sql/cron.example.sql` updated.
- Deployed kis-ingest, krx-ingest and pipeline-report around 12:09 KST. Not seen yet: a real pre-open (`B`) response
  and an after-market (`A`) one; the 11-16 fixture only has `C` (3 preferred shares in VI) and `0`.

## 2026-11-19 — get_stock_history: smaller rows, at most 120 days
- **Done:** the stock's fields (종목코드, 종목명, 시장, 소속부) are given once at the top, and each row is 일자 plus the
  day's numbers; `days` max 250 → 120 (~6 months, `screen_stocks`' longest window). A 120-day answer is ~30 KB
  (built from production rows for 005930 and 247540). **Why:** `days=250` returned 66 KB, over the 64 KB limit
  (SIZE-2); a year of daily rows is mostly noise in the model's context, and the Naver weekly/monthly chart links
  cover the long view. Real calls so far asked for 20, 20, 3 and one 250. Deployed; a production `days: 120` call
  (253450) returned 22.4 KB.
- **Found:** history's latency isn't the query: in Postgres it's ~10 ms (`pg_stat_statements`: 614 calls) and uses
  `daily_prices_code_date_idx`. The `history` step took ~500 ms for 3 calls after an hour idle (12:27) and 45–90 ms
  for 3 calls 50 s later; PERF-1's 1.5 s (n=3) was all after-idle calls. Moved to the cold-calls item below.

## 2026-11-19 — analyze_stock's quote: no rate-limit waits
- **Checked:** quotes during a kis-ingest burst. 3 `analyze_stock` calls landed at 12:50:09, inside the 12:50 run's
  KIS phase (~12:50:03–12:50:14.5; the run itself got 3 rate-limit answers, within its usual 1–9): `kis_quote`
  657–753 ms, no `kis_rate_limited` step, the same as quotes with no run going (572–778 ms). No quote with timings
  has had a rate-limit wait (0 of 10, 3 during a burst). So shortening the quote's backoff, pacing kis-ingest more,
  or a separate KIS app key aren't needed.
- **Found:** `analyze_stock`'s ~1.1 s is the stored-token lookup (`kis_token`: ~400 ms after idle, ~70 ms warm; the
  quote waits for it) and the quote itself (~650 ms). The first is the after-idle warm-up (cold-calls item below).
  The second is mostly opening a new connection to KIS, not the distance: in the 11-19 bench, 40 of 51 quotes took
  125–152 ms on a reused connection and 11 took 533–746 ms on a new one; real calls minutes apart always pay it.

## 2026-11-19 — krx-ingest in Seoul: loading run 46 s; tool_calls kept
- **Checked:** the first loading run in Seoul with parallel markets (08:00, loaded 11-18, 2,771 rows): 46.5 s, against
  126 s from Mumbai on 11-18. KRX calls 35.2 s wall (KOSPI 35.2 s for 276 KB, KOSDAQ 25.1 s for 548 KB, in
  parallel), upsert 5.6 s (Seoul → the database), the KIS comparison read 1.6 s and the cleanup 0.6 s (both removed
  since, today). The KRX calls are KRX's own time: the same calls take 0.1–0.3 s for today's date (nothing yet) and
  ~11 s for a published-but-not-ready day. Runs that load nothing: 3–16 s. kis-ingest today: max 21 s (n=46). ING-1
  met: 46 s against the 112 s that leaves 25% of the 150 s limit.
- **Decided:** `tool_calls` has no retention: few users, and it's the record of real usage (the latency and size
  findings above came from it). CAP-4 updated.

## 2026-11-19 — Warm bench after the feed function
- **Ran:** `deno task bench` (n=50, 5 rounds, 60 s pauses), 12:57–13:05 KST, during the session (so with KIS quotes).
  It landed in ap-northeast-2 (no `--region`), so end-to-end totals aren't comparable with PERF-6's us-east-1
  baselines; the server-side numbers are.
- **Found:** warm server p95 (each round's first call excluded, n=45): Tier A 71–203 ms (history 71, feed(1h) 203
  against 453 on 11-17), Tier B analyze 770, screen 406. PERF-5 met.
- **Found:** each round's first call, after only a 60 s pause, pays the database connection warm-up (feed(1h)
  374–724 ms, its first steps ~450–600 ms each in parallel). So an open connection doesn't survive a minute idle.
- **Found:** KIS quotes are bimodal: 125–152 ms on a reused connection (40 of 51), 533–746 ms on a new one (11 of 51).
  None was rate-limited, though the bench overlapped the 13:00 and 13:05 kis-ingest runs.

## 2026-11-19 — Telegram gate in production (built, not deployed yet)
- **Done:** telegram-ingest gates posts after polling (`telegram-ingest/gating.ts`, prompt and checks in
  `_shared/gate.ts`, shared with `scripts/tg_gate.ts`, so the experiment and production can't drift). The newest posts
  with `gated_at` null, 40 per run, 8 calls at a time: label, `stock_codes` (checked KR codes), `us_tickers`, `events`,
  `gate_version`, `gated_at` (migration `20261119000000`). No tags table. Posts with no text are noise without a call.
  **Why:** the experiment (prompt v5) held up on 741 posts.
- **Done:** one rule re-gates: `gated_at = null`. A trigger sets it when a post's text changes; adding or changing an
  event (`telegram_events`) sets it for the posts since its `active_from` (or the last 7 days). The ~1,000 stored posts
  (back to 2026-08-03) are gated the same way, newest first: ~2 hours after deploy, ~$0.20.
- **Done:** failures. A failed call leaves the post ungated (shown, untagged) for the next run; a run where every call
  fails (key, outage) returns 500 with `gate.error`, which alerts once an hour like a failed run.
- **Done:** `us_symbols` (Nasdaq Trader's two files, ETFs and test issues dropped, ~7,450 rows), refreshed by
  telegram-ingest when a day old; a list under 5,000 rows is refused and the stored one kept. Delisted tickers drop out.
- **Done:** mcp. Noise is hidden from `get_telegram_feed` (the `telegram_feed` SQL function, v2) and `search_telegram`;
  `include_noise: true` shows it (`noise: true`). Both filter by `us_stock` and `event`, and posts list `us_stocks`
  (ticker, name) and `events`. New tools: `find_us_stock` (ticker or English name; Korean names aren't searchable, the
  calling model translates) and `list_telegram_events`.
- **Done:** the name matcher (`tagStocks`, the stock index) is out of production: posts are stored untagged and the gate
  tags them, so a new post has no tags for up to one run (5 minutes). It lives in `scripts/name_matcher.ts`, with its
  tests, as the experiment's baseline. `STOCK_ALIASES` moved to `gate.ts` (the KR check uses it). The `?retag=1`
  endpoint is gone (deprecated).
- Tests: `gate_test.ts` (the checks, with the experiment's cases: MS/Microsoft, 록랩, SK하이닉스 ADR, 현대차, 아울렛);
  db_test: the trigger, an event re-gating, `gateBatch` with a stand-in client (written-back tags, an empty post, every
  call failing), `refreshUsSymbols`; mcp_test: noise hiding, the US and event filters, the two new tools. 136 unit, 37
  DB, 45 MCP tests pass.
- **Done:** the daily report has a gate line under the Telegram one: posts gated in the 24 hours, the noise share,
  failed calls, the backlog after the last run, and tokens with their cost at Haiku's price, e.g. "✅ Telegram gate:
  120 posts gated, 15% noise (18) · 180K in / 12K out tokens ≈ $0.02". No line when no run gated (no key).
- **Done:** `telegram-ingest?gate=500`: no polling, gates up to 500 ungated posts at once (new calls stop after 100 s,
  inside the 150 s limit). For the posts stored before the gate, instead of draining at 40 per run.
- To deploy: `ANTHROPIC_API_KEY` secret, `supabase db push --remote`, deploy telegram-ingest, mcp and pipeline-report, then
  `?gate=500` twice for the stored posts, then add events.

## 2026-11-19 — Telegram events: a window per post, re-gate only on a new event
- **Found:** `anthropic-ipo` (active_from 11-01) tagged 77 posts back to 10-12, 20 of them before 11-01. Not the manual
  `?gate=500` calls: the gate offered every active event to every post, whatever the post's date, and the event was
  added (08:01 UTC) before the backlog was gated (08:02–08:06). The automatic drain would have done the same.
- **Found:** moving the event's `active_from` to 10-12 reset 1,005 posts (the trigger fired on any change to
  description or active_from), although all had been gated with the event in the list. Undone: those posts were set
  gated again (`gated_at = now()` where `gate_version` is set), nothing was re-run.
- **Done:** an event is offered only to posts inside its window (`active_from` ≤ ts < `active_to`, `eventsAt` in
  `telegram-ingest/gating.ts`), and only inserting an event re-gates posts: those in its window (migration
  `20261119000001`). An edit re-tags nothing; reset the posts yourself if it should (README SQL). An ended event
  applies to the posts of its window if they're ever re-gated. `active_from` is required, by default 7 days before
  the event is added (a null start meant a 7-day reset but tagging with no start).
- Noted: a manual `?gate=N` during a scheduled run can gate the same posts twice (08:04–08:05 today). Harmless.
- **Found:** telegram-ingest failed once (16:58 KST, "column telegram_messages.gated_at does not exist"): the function
  was deployed before its migration reached production, because the deploy steps given said plain `supabase db push`,
  which in CLI v3 targets the local stack. The right command is `supabase db push --remote`, now in CLAUDE.md.

## 2026-11-19 — KIS after-market: traded prices, change from the previous close
- **Checked:** the after-market runs (수능 day: regular session to 16:30). Between the 17:05 and 18:05 snapshots 1,911
  of 2,771 closes changed and volume grew for 2,157, so `intstock-multprice` (market `J`, KRX) follows after-market
  trades. `close − change` equals the previous day's official close for 2,659 of 2,661 traded stocks (the other 2:
  SPACs with a rounded base price), so `change`/`fluc_rt` stay measured from the previous close (CORR-1 met).
- **Found:** a raw response at 18:08 (fixtures/intstock_multprice_20261119.json): after-market rows have
  `hour_cls_code` `0`, not `A`, and KIS's high/low include the after-market trades (every price inside the range, in
  the fixture and in all 2,661 traded rows of the 18:05 snapshot). So the after-market needs no exemption from the
  low..high check; `A` is an auction after the close. The 18:05 snapshot is kept as
  fixtures/live_prices_20261119_1805.json (gitignored).
- Not collected: NXT (Nextrade), a separate venue with its own after-market (market code `NX`, combined `UN`).

## 2026-11-20 — Telegram fetched from Seoul; posts the preview can't fully show
- **Found:** adding @stockbot failed with "no public web preview", though t.me/s/stockbot loads in a browser. The add
  ran in Mumbai (`mcp`, forwarded to `DB_REGION`), where Telegram redirects t.me/s/stockbot to t.me/stockbot (a stub
  page: no title, no subscriber count). A temporary probe function (deployed, called with `x-region`, deleted) got
  the full page from Seoul, Tokyo and Singapore, and the redirect only from ap-south-1; insidertracking loaded
  everywhere. So it's a per-country restriction on that channel, not datacenter IPs. MTProto (a user account) isn't
  needed for it.
- **Done:** t.me is fetched from Seoul. The telegram-ingest cron sends `x-region: ap-northeast-2` (production job
  updated, `sql/cron.example.sql`); its response has `ran_in`. `mcp` keeps running next to the database and, with
  `TG_REGION=ap-northeast-2` (secret), fetches every page (add check, refresh, background backfill) through
  telegram-ingest's new `?page=<channel>&before=<id>` relay, which returns `{status, html}` as fetched there and isn't
  an ingest run. If the relay fails (network, auth, 5xx), the page is fetched where `mcp` runs (`relayPages`).
- **Done:** `parsePage` also reads a post's text from `media_supported_cont`. Every stockbot post is in the
  `text_not_supported_wrap` layout (custom emoji): the text sits one level down, next to a "Please open Telegram"
  notice, so 16 of 20 posts parsed blank and `pageProblems` refused the page. Tested inline and with the real page
  (fixtures/tme_s_stockbot.html, gitignored).
- **Result:** @stockbot added in production: "Trade Watcher", 160 posts back to 11-08 (8 backfill pages), 1 blank.
- **Checked:** the parser against two live pages of each of the 10 collected channels (377 posts): every text in a
  post's bubble was compared with the parsed text, Telegram's UI left out. All 377 posts parsed, the posts' own text
  fully. The `media_supported_cont` case isn't stockbot-only: insidertracking 69790 ("금일 … 주요 일정 / 특이사항
  없음") was stored blank and labeled noise.
- **Done:** `parsePage` also keeps a link preview's site name and description (`[site · title]`, then the
  description; the title alone before) and a poll's question and options (`[poll] …`, `- option`). Left out on
  purpose: quoted replies (another post's text), poll percentages (they change with every vote, and a changed text
  re-gates the post), file sizes and "Anonymous Poll". After that, only those were missing (35 pieces, 4 posts).
  Deployed (telegram-ingest, mcp).
- **Done:** recovered posts stored blank before the fix. The 151 posts with empty text were re-read (40 preview
  pages, fetched from the operator's machine in Korea and parsed with the new parser): 50 had text (44 insidertracking, 5 durov, 1
  itechkorea poll; 30 of them photos with a caption), all 50 labeled noise. Their text was set where still empty
  (49; one had been fixed by a poll after the deploy), which re-gates them. The other 101 are media only. Re-gated:
  44 market, 6 noise.
- **Fixed:** the gate failed (alert 12:55) on 11 durov posts from 08-03 to 10-11: older than every event window, so
  `outputSchema` sent `events` as an array with `maxItems: 0`, which structured outputs reject (400 "For 'array' type,
  property 'maxItems' is not supported"). It had never been sent before: those posts were blank, and a blank post is
  labeled noise without a call; the parser fix gave them text. Now a post with no events gets no `events` field at
  all (askGate reads a missing one as none), and gate_test checks the schema for keywords structured outputs reject.
  Deployed (telegram-ingest).
- Also today: `us_symbols` refreshed early (its `updated_at` set back a day) to pick up ANT, listed 11-19; ANT added
  to `us_tickers` of the 94 posts tagged `anthropic-ipo` by hand, without re-gating them.

## 2026-11-20 — YouTube transcripts (deployed the same day)
- **Decided:** transcripts from Apify (`apihq/youtube-transcript-scraper`), new uploads from each channel's RSS feed.
  **Why:** YouTube's official captions API only serves a video's owner, and its caption files refuse cloud IPs (the
  libraries' own docs, and reports from November); the RSS feed answers from Supabase (checked from ap-south-1:
  200, 15 entries). The actor returns one record per video (a failure doesn't fail the batch, and isn't charged):
  $0.003 a transcript, ~5 s for one video, 23 s for five in one call.
- **Done:** `youtube_channels` / `youtube_videos` (migration `20261120000000_youtube.sql`) and `youtube-ingest`, every 5
  minutes: poll each active channel's feed (a first poll keeps the newest 5 videos, later polls every newer one, no
  Shorts), then fetch up to 10 due transcripts, newest first, one actor call per language. A video without a
  transcript yet is retried after 15 min … 8 h and given up on ('none') 48 h after publishing; a transcript in another
  language than the channel's is not taken (the first try without `language` returned YouTube's auto-translated
  English). A failed feed or a failed actor call fails the run (500 → ingest_runs, hourly alert); a failing channel is
  retried hourly. Unit tests (feed parsing on a real feed, backfill rule, retry decisions) and DB tests (fake feed,
  fake actor); checked once end to end on the local stack with 기릿의 주식노트 (5 transcripts, $0.015).
- Channels (by id): 기릿의 주식노트 `UCw8pcmyPWGSik7bjJpeINlA`, 박종훈의 지식한방 `UCOB62fKRT7b73X7tRxMuN2g`, 오선의 미국
  증시 라이브 `UC_JJ_NhRqPKcIOj5Ko3W_3w`, 시황맨TV `UCRCNBeNS8MrOwFV6h6Yjemw` (found by name in YouTube search).
- Auto-generated Korean captions get names wrong (엔트로픽, "SO" for S-Oil), so the gate's name check matters more here.

## 2026-11-20 — YouTube MCP tools (built, not deployed)
- **Done:** `add_youtube_channel`, `get_my_youtube_channels`, `update_my_youtube_channels`, `list_youtube_videos`,
  `get_youtube_transcript` (mcp/youtube.ts), and `user_youtube_channels` + `youtube_channels.added_by` + a trigram index
  on transcripts (migration `20261120000001`). An @handle is resolved from the channel's page (it loads from Mumbai:
  checked with two handles), a new channel's feed is checked and polled at once (newest 5 videos; youtube-ingest
  fetches their transcripts). At most 20 channels, since each video costs a transcript.
- **Long transcripts:** in production 기릿 averages 4.7k characters, 시황맨 8.5k, 박종훈 11.7k, and 오선's live streams
  82k (up to 202k for a ~10-hour stream). MCP clients cap an answer (Claude Code warns at ~10k tokens and cuts at
  25k), and SIZE-1/2 cap ours (20 KB p95, 64 KB; Korean is 3 bytes a character), so `get_youtube_transcript` returns
  one part at a time: ~6,000 characters by default (≈18 KB), at most 15,000, cut at a segment, a `[m:ss]` marker each
  minute, and `next_from_seconds` for the next part; `query` returns only the passages around a phrase (spacing
  ignored, since auto-captions space Korean loosely) with their times and a link to that second.
  `list_youtube_videos` stops at ~48 KB and says how many it left out.
- Tests: unit (resolveChannel, transcriptPart covers every segment once across parts, transcriptMatches), MCP
  (paging to the end, query, pending note, title lookup, follow/unfollow scope).
- **Changed:** `list_youtube_videos` lists only videos with a transcript (a video without one has nothing to read
  yet) and counts the ones still waiting; `list_youtube_channels` lists every collected channel (counts, poll state),
  like `list_telegram_channels`, and `get_my_youtube_channels` now lists only the user's own.

## 2026-11-20 — X posts through Apify (built, not deployed)
- **Decided:** `xquik/x-tweet-scraper` on Apify. **Why:** X's own API is pay-per-use only (~$0.005 a post read). Of
  the Apify actors that work on the free plan (tested live on @KobeissiLetter: apidojo/tweet-scraper $0.40, kaitoeasyapi
  $0.25 and xquik $0.15 per 1,000), xquik is the cheapest and fastest (2 s), takes many handles in one run, and
  filters by time and post type in the actor, so retweets aren't paid for. An empty run costs ~$0.00007.
- **Done:** `x_accounts`, `x_posts`, `user_x_accounts` (migration `20261120000002_x.sql`), `x-ingest` every 5 minutes
  (offset 4 minutes from telegram-ingest), and the tools `add_x_account`, `get_my_x_accounts`, `update_my_x_accounts`,
  `list_x_accounts`, `get_x_feed`. A new account gets its latest 20 posts once; then one run for all accounts asks
  for posts since the oldest last poll minus 10 minutes (posts are upserted by id, so the overlap only refreshes
  counts). Posts keep the quoted post's text and image URLs (Bilello's posts are mostly charts: 13 of 20).
- **Found while testing:** a failed run moved `last_polled_at` forward, which would have skipped the posts between
  the last success and the failure (the next run asks from it); now a failure only records the error. And an
  answer with the same post twice failed the whole save (an upsert can't take one row twice); posts are now
  de-duplicated by id first.
- Checked on the local stack: `add_x_account @charliebilello` stored 20 posts (no retweets; 3 quotes, 3 replies,
  13 with images) in 6 s for $0.0032; two polls after it found nothing new, $0.000065 each.
- Cost of a poll doesn't grow with accounts: an empty run for 4 accounts cost the same as for 1 ($0.0000644 vs
  $0.0000643), so polling is ~$0.56 a month in all, plus the posts.
- `get_x_feed` keeps its answer, as sent, ≤ 64 KB (SIZE-2), as many of the newest posts as fit (~90 of Bilello's,
  ~530 bytes each), and says how many it left out.
- Not gated yet (no noise label or stock tags on X posts).
- Deployed 11-20: migration `20261120000002`, x-ingest, cron job 20 (`4-59/5`). No account yet.
- **Added:** each account's bio, follower count and verified flag (migration `20261120000003_x_profiles.sql`), from
  the author of its newest post in each actor answer (free: every post carries its author's profile), kept current
  on every poll, shown by `list_x_accounts`, `get_my_x_accounts` and `add_x_account`. **Why:** stored rather than
  left to the model to look up: X profile pages show fetchers a login wall, clients differ in web access, and a
  model's memory of a bio can be stale (it was, here, for Bilello's).

## 2026-11-20 — X posts gated like Telegram's (built, not deployed)
- **Done:** gate columns on `x_posts`, the edit trigger, and the event re-gate extended to X posts (migration
  `20261120000004_x_gate.sql`). `gateBatch` takes a target (`TELEGRAM_POSTS`, the default, or `X_POSTS`), so both use the
  same prompt (v5), the same name check against the KRX and US lists, and the same shared `telegram_events`. An X post
  is read as `@handle (X)` with the post it quotes appended (a quote is often only a comment on it), and its images
  count as media. x-ingest gates up to 40 posts a run after polling (the 80 stored posts drain in two runs).
  `get_x_feed` shows `stocks`, `us_stocks`, `events`, hides noise unless `include_noise`, and filters by them.
- Not checked yet on real posts with the real model (tests use a fake Claude): after deploy, spot-check a run's
  labels and tags.

## 2026-11-20 — Thesis tracking designed (docs/plan.md → Phase 4)
- **Decided (design only):** keep market theses (claim, starting evidence, verification conditions, links to events /
  KR codes / US tickers) and their review history, and serve "what's new for this thesis" as data: tagged posts,
  transcript passages, prices, and computed facts about its conditions. The calling LLM does the review (in a chat or
  its client's scheduled task) and records its verdict with `record_thesis_review`. Events tie it in: the gate's tags
  already say which new posts are evidence for a thesis.
- **Corrected the same day:** the first draft had the server review theses itself (Opus 5.5 at 17:00, a Telegram
  digest). Wrong role: this is an MCP server, its job is the data; judging is the caller's. At most it advises
  (tool descriptions, an MCP prompt). So no server-side model, no digest, and no exception to "no insight features".
- Decided: users add events through a tool (`add_event`: at most 30 days back, a few a day per user, `added_by`
  kept; events stay shared, since the gate tags everyone's posts with them); theses and reviews are private to
  their user.

## 2026-11-21 — Telegram page fetches: timeout and one retry (deployed: telegram-ingest, mcp)
- Two failed telegram-ingest runs overnight, each one channel: itechkorea at 03:20 KST and ehdwl at 05:50, both
  `connection error: connection reset` from t.me's IPv6 address. Each channel worked again on the next run (5 min
  later). But the 03:20 run took 117 s (p50 over 2 days ~18 s): the connection hung ~95 s before the reset, close to
  the 150 s wall-clock limit, where the gate and the ingest_runs row would have been lost too.
- `directPage` (../supabase/functions/_shared/telegram.ts) now gives each attempt a 10 s timeout and retries a network
  error or timeout once, after 1 s. An HTTP answer (429, 5xx, a redirect) is not retried. Worst case per channel ~21 s
  instead of unbounded. The relay (mcp's page fetches) goes through the same function, so it gets this too.
- Why 10 s (first deployed with 15 s, lowered the same day): over 864 runs (3 days) a channel's poll takes p50 ~1.0 s,
  p99 ~2.4 s (fetch and DB writes, from run time minus gate time per channel polled); a single fetch ~2 s. 10 s is ~4×
  the p99, and four stuck channels (~84 s) still fit in the 150 s limit; at 15 s, four (~124 s) would not.
- Watch for `connection reset` / `no answer in 10 s` in `ingest_runs.summary->'results'`.

## 2026-11-21 — Telegram unreachable for a whole run: the poll loop stops early (built, not deployed)
- The 15:35 KST run was killed at the 150 s limit (`ingest_runs` 1959: no summary). The gateway logs show why: from
  15:35:03 every channel took ~21.2 s (10 s timeout, 1 s pause, 10 s timeout, then the error path's poll_errors
  update), six channels in a row, and the limit hit during the 7th (tnbfolio). Telegram didn't answer from Seoul for
  those ~2.5 minutes; the 15:40 run was normal (32 s). Nothing was stored or gated, and no alert listed the channels.
- My 10 s reasoning in the morning entry was wrong where it mattered: "four stuck channels fit" assumed failures are
  per channel. When t.me itself is down every channel stalls, so 10 channels × ~21 s ≈ 212 s, at any timeout above
  ~6 s. The fix belongs in the loop, not the timeout.
- `telegram-ingest/polling.ts`: polling stops after 2 channels in a row with no answer at all (`PageNetworkError`,
  marked `unreachable` in the channel result; a broken page or an HTTP status doesn't count), so such a run ends
  after ~43 s. No channel starts after 60 s from the run's start (normal: all 10 in ~15 s). Channels not polled are
  left as they are and come first next run (oldest `last_polled_at` first).
- The run then reports `poll_stopped` and `not_polled`, returns 500, and alerts once (the hourly whole-run alert;
  per-channel "started failing" alerts are skipped for an outage). `errorOf` names the stop first. Stalled
  backfills are skipped after a stop or past the deadline, and the gate starts no call after 110 s from the run's
  start (`gateBatch`'s new `stopAt`; before, its 100 s deadline counted from the gate's own start).
- Not covered: one channel whose catch-up fetches 5 slow pages that each answer just under 10 s (~50 s); then a
  started channel can end near 110 s. Rare (a gap and a slow t.me at once).
## 2026-11-26 — Pipeline health check; fake Telegram channel deactivated
- **Telegram:** `thekobeissiletter` ("The Kobeissi Letter", 11.5k subscribers) has had no public preview since
  11-23 19:00 UTC (`t.me/s/…` redirects to the channel page), and it carries Telegram's FAKE badge: an impostor of the
  real Kobeissi Letter. It failed every telegram-ingest run since (52 in a row, ~60 failed runs/alerts in the week).
  **Done:** `active = false` in production (not deleted: its 243 posts, 11-11 → 11-23, and 1 subscription are kept).
  The other 9 channels poll fine. The other failures in the week were the 11-21..11-24 t.me outages (poll loop stop).
  Gate backlog 0.
- **YouTube:** the Apify actor's runs failed as a whole on 11-23 07:32–12:47 UTC (~64 runs, `run-failed`). The batch
  was four ordinary videos, all transcribed on the first good run (12:52), so the outage was Apify's. Nothing was lost;
  every run since is ok. The one video still without a transcript (`eEHBDFbB9vU`, 11-25 live stream) is waiting for
  captions, which is normal: earlier ~10 h streams took 7 tries.
- **X:** 1 failed run in the week (Apify 502, 11-22); all 4 accounts current, gate backlog 0.

## 2026-11-26 — `daily_prices_screen_idx` dropped (migration `20261126000000_drop_screen_idx.sql`)
- **Why:** 67 MB (the largest index; `daily_prices` was 261 MB of the 321 MB database), with the same key as
  `daily_prices_pkey`, kept for one rarely used tool: `screen_stocks` had 8 calls 11-17 → 11-25, one user. Its 120k
  scans were mostly the Telegram/X feeds' stock-name lookup (`bas_dd = … and isu_cd in (…)`), which also reads
  `isu_nm` from the heap and is as fast on the pkey. Every other `daily_prices` read already used the pkey or
  `daily_prices_code_date_idx`. Also, the index wasn't really index-only: 36k of 61k rows in the 21-day read were
  heap fetches, since the days loaded after the 11-13 autovacuum weren't all-visible.
- **Checked first (production, read-only EXPLAINs through `prices`, a `mktcap` filter standing in for "no covering
  index"):** the `materialized` CTE keeps the plan on a pkey range read + sort at 21, 60 and 120 days. Without
  `materialized` the planner switches to `daily_prices_code_date_idx` from ~60-day windows on (at 21 days it doesn't),
  which is the 10-11 8.5 s plan. Times: 21 days ~0.24 s warm / ~2.0 s cold either way; 120 days (the max for
  `avg_days`, `sideways_days`, `volatility_days`) 1.4–3.6 s with the index, 1.8–4.2 s without (at 2 MB `work_mem`,
  sort on disk; the function sets 64 MB); 120-day breakout highs 0.23 s vs 0.3–0.4 s. Under 5 s at the extremes.
  The heap is about in date order (krx-ingest inserts each day once), so the pkey range read stays on neighbouring pages.
- **Done:** `drop index`, and `screen_stocks` v7 = v6 with only the CTE comment changed (production's body was diffed
  against v6 first: identical). Local: `deno task check`, `test` (170), `test:db` (43), `test:mcp` (52) pass.
- **Rollback:** re-create the index as in `20261011000002_screen_stocks_volume.sql` (a few seconds).
- **After the push (11:55 KST, production):** `daily_prices` indexes 127 → 60 MB, database 321 → 254 MB. Every read
  in the function stays on `daily_prices_pkey`; the feeds' stock-name lookup moved to the pkey (1 ms).
  `screen_stocks` end to end through MCP: the default screen (20-day, -8%, ≥100억) 1.0 s, of which the RPC took
  0.63 s (it was 1.5–1.9 s before). Worst case (avg/sideways/volatility 120 + breakout 20/60/120): one call alone
  3.9 s (RPC 3.6 s); **two such calls at the same moment both hit the 8 s statement timeout** (10.6–10.9 s).
  The raw 120-day window read was 6.3 s on its first run after the drop and 2.1 s after. Not measured: the same
  worst case before the drop, so how much of this the drop added is unknown.
- **Then (built, not deployed):** `screen_stocks`' `avg_days`, `sideways_days` and `volatility_days` capped at 60 in
  the MCP schema (was 120). **Why:** the 120-day window is what timed out, and no real call has used more than 20
  (the one other user: 8 calls, all 20-day, no `breakout_days`). `breakout_days: [120]` stays (its read is 0.3–0.4 s);
  `analyze_stock` keeps 120 (one stock). The SQL function still accepts 120 (MCP is its only caller).
  `mcp_test.ts` checks 61 is rejected for each.

## 2026-11-26 — Korean market indicators: `market_quotes` + `market-ingest` (deployed the same day)
- **Decided:** one table of current values (one row per symbol, overwritten; `price` + `prev_close`, no stored change),
  US stocks later in a table of their own. KIS only for Korean data; US indices, US yields and the BOK base rate are
  left open (KIS has SPX/COMP/NDX/SOX/VIX and US yields, but not the Dow or Russell 2000; Alpaca has no index values;
  Treasury.gov's daily curve, no key, is ready the same evening ET).
- **Probed (11-26, KIS, read-only, production's cached token):** KOSPI `0001` / KOSDAQ `1001` (inquire-index-price):
  live mid-session. KRW/USD `FX@KRW` (서울외국환중개): **real time**, 1343.1 → 1343.2 → 1343.1 → 1342.9 over 13:08–13:11.
  국고채 `Y0104/0101/0105/0106/0116/0117` (chart endpoint, market `I`): at 12:37 still the 11-25 value, at 13:11 a value
  for 11-26, so KIS updates them during the day but not continuously; fetched once a day for the final value. An
  unknown code answers rt_cd 0 with zeros. US condition search pages 100 at a time (Nasdaq 4,534 stocks = 46 calls),
  so a whole-US snapshot is ~as cheap as kis-ingest's.
- **Done:** migration `20261126000001_market_quotes.sql`; `market-ingest` (`?set=live`: KRW/USD, plus KOSPI/KOSDAQ
  09:00–15:40 KST when KOSPI's newest bar is today; `?set=bonds`: 국고채 1–30년), each symbol on its own so one failure
  names itself; values rounded to the unit (KIS sends `1344.2999`); `get_market_overview` (MCP: change and % for
  indices/FX, basis points for yields, value_date and as_of); cron jobs in `sql/cron.example.sql` (live every 5 min
  09:01–01:56 KST Mon–Fri, 1 min after kis-ingest; bonds 18:30 KST); `deno task fixtures market`.
  Local: `check`, `test` (177), `test:db` (43), `test:mcp` (53) pass; `market-ingest` run end to end locally against
  KIS stored all 9 symbols.

## Open
- Cold calls (~+2.2–3.5 s each, every tool): decide on a keep-warm ping (pg_cron, one ping landing in us-east-1 and one
  next to the database, every minute) vs. moving the project to us-east-1. A ping every minute would keep workers
  alive (the boot), but probably not the database connection: in the 11-19 bench, calls after a 60 s pause already
  paid its ~400–600 ms setup. Then `screen_stocks`' cold SQL (1.3–1.9 s
  against ~0.25 s warm): `explain (analyze, buffers)` right after an idle period, to see if it's reading from disk.
  - Also a smaller warm-up with no worker boot: the first database call after an idle period costs ~400–500 ms
    against 45–90 ms warm (11-19: `get_stock_history` 495–503 ms at 12:27 after an hour idle, 45–90 ms at 12:28;
    the query is ~10 ms in Postgres). Across tools, the first call in a request is p50 141 / p90 549 ms against
    p50 70 / p90 127 for later ones. History pays it on every after-idle call because it's its only step, so its
    PERF-1 number (1.5 s, n=3) is this warm-up, not the tool. A keep-warm ping would cover both; re-measure PERF-1
    separating warm from after-idle calls.
  - `analyze_stock` pays it in the stored-token lookup (`kis_token` ~400 ms after idle, ~70 ms warm), which the KIS
    quote waits for.
  - `get_telegram_feed` too: real calls since the `telegram_feed` function (11-18 12:32 – 11-19 12:24, all with the
    default window) are p50 106 ms when another call came < 5 min before (n=99) and p50 553 / p95 811 ms after idle
    (n=15); the `messages` query is 40–90 ms warm, and the slow ones are the first steps (`user_channels`,
    `latest_trading_day`, `backfill_state` ~400–500 ms). The "warm" p95 (676 ms) includes parallel bursts (5 calls at
    22:23, ~1 s each), where each call sets up its own connection. PERF-5/6's 1h/30-post case (453 ms warm tool p95,
    1.7 s end to end, 11-17) predates the function. Re-measured on 11-19: warm server p95 203 ms (PERF-5 met);
    end to end (PERF-6) still needs `deno task bench --region us-east-1`, best after 15:30 (`analyze_stock` then
    makes no KIS calls).
- Load benchmark (`bench:load`, not built): latency and errors vs. concurrency (1 → 5 → 10 → 25 → 50) to find the
  knee and the first bottleneck (Postgres connections or compute, PostgREST, Edge workers, the forward hop), using
  the per-step `timings`. Database-backed read-only tools only, outside the session (no KIS or t.me calls), via the
  operator key (unlogged); short runs, within free-plan fair use. Framed as knowing the limits, not as needing scale.
- 11-30: check the `live_prices` cleanup (no day older than 10 days).
- `market-ingest` (deployed 11-26: migration, `market-ingest` v1, `mcp` v63, cron jobs `market-ingest-live` and
  `market-ingest-bonds`; first run 14:01 KST ok, 1.6 s, 3 symbols). Check: KRW/USD keeps updating in the evening session
  (15:30–02:00 KST; only the daytime was probed), and the 18:30 bonds value is the day's final one.
- US market data (open): US indices (KIS or other), US stocks (own table; KIS condition search or Alpaca), US yields
  (Treasury.gov daily; intraday unknown), BOK base rate (ECOS key).
- `screen_stocks` window cap (11-26, built, not deployed): deploy `mcp`, then check that `avg_days: 61` is
  rejected. After that, watch `tool_calls` for `screen_stocks` timeouts.
- Telegram gate, after deploy: watch the backlog drain (`gate.left` in telegram-ingest's `ingest_runs` summary), the
  failure count, and the first `us_symbols` refresh; spot-check hidden noise with `include_noise: true`.
- Normalized chunks for Telegram posts (dropped from Phase 2 on 11-19, needed after all): posts stored as clean,
  non-clipped pieces (a digest split by topic), so a filtered feed returns the relevant part instead of a post's
  opening. The size problem it would solve, measured on `get_telegram_feed(event: anthropic-ipo)` (77 posts,
  10-12 → 11-19): at the default `max_chars` 1,500 the answer is ~92,000 characters (~90K tokens); at 600 it's ~42,000,
  but 30 of the 77 posts mention Anthropic only after their first 600 characters (daily digests where the IPO is one
  item), so the cut shows the digest's opening. Same for stock filters on digests. `search_telegram` doesn't have it
  (snippet around the query word), but only matches one spelling (앤스로픽 or Anthropic-only posts drop out). Kept
  as-is for now. Open: how to split (the formatting differs a lot by channel: headings, bullets, prose), and what the
  feed counts (posts or chunks).
- YouTube: ingest deployed 11-20 (4 channels, job 19 every 5 min; first run 15:12 KST, 20 videos). Next: gate the
  transcripts (label, stock and event tags, as for Telegram posts; a live stream's 80k+ characters needs chunks or
  a summary first), and a YouTube line in the daily report. MCP tools: deploy `mcp` after `supabase db push --remote`
  (migration 20261120000001).
- X: deployed with 4 accounts (Bilello, Bespoke, SentimenTrader, Liz Ann Sonders). Gate: deploy migration
  `20261120000004`, x-ingest and mcp, then check the first gated posts.
- Thesis tracking (plan.md → Phase 4): build 4.1 (tables, thesis tools, `add_event`).
