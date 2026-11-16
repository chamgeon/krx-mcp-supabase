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

## Open
- Deploy `krx-ingest`, `kis-ingest`, `telegram-ingest` and `mcp` (all changed in the 11-16 entries).
- Alert on ingest failures (e.g. a Telegram message): refusals only show in function logs and `last_error` now.
- Run the `screen_stocks` vs. `analyze()` comparison on a copy of production data (all ~2,800 stocks) to find
  disagreements the seed can't show.
- CI: run `deno task test` on every push.
- Telegram tagging matches only 6-digit codes, so the 96 alphanumeric 종목코드 can be tagged by name only.
