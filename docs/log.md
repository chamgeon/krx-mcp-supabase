# Design Log

What was done and why. Oldest first; new entries go at the bottom.

## 2026-10-11 — Architecture
- Supabase free plan only: scheduled Edge Functions load Postgres, one Edge Function serves it over MCP. All numbers
  come from SQL/TS; the LLM is client-side only. **Why:** no cost, reproducible numbers.
- Each user registers their own KRX key. **Why:** KRX's terms forbid passing the data on.
- A secret `?key=` URL and RLS with no policies (service role only). **Why:** Edge Functions have no MCP auth.

## 2026-10-11 — `screen_stocks` performance
- Covering index `daily_prices_screen_idx` read through a `materialized` CTE; window functions over ~21 days only;
  60/120-day highs only when asked. **Why:** PostgREST's 8 s timeout; ~350k random heap reads timed out.

## 2026-10-29 — Intraday data from KIS
- `kis-ingest` snapshots the whole market every 5 min and after the close; KRX's official data replaces it the next
  morning; tools return `data_status`. **Why:** KRX publishes a day only the next morning.
- Stock list, market, 소속부, 상장주식수 carried forward from the previous day (KIS has no whole-market endpoint).
  The KIS token is cached in `kis_token` (KIS rate-limits issuance).
- Zero high/low = missing; an untraded stock is never a breakout. **Why:** KRX reports halted stocks with 0 high/low.

## 2026-11-10 — Plan pivot
- Telegram data became Phase 1; DART and valuation to the backlog; knowledge graph and hypothesis backtesting dropped.
  **Why:** the PB interview (insight comes from experts on Telegram; PBs don't want AI "insight"). See `docs/plan.md`.

## 2026-11-13 — Login, Telegram, live/history split
- **Decided:** OAuth login (Supabase Auth, Google only; Kakao dropped: its email consent needs a 비즈 앱), not
  per-user keys. Server asks only for `offline_access` (refresh tokens). Consent page on GitHub Pages (Supabase serves
  HTML as plain text). The shared `?key=` URL still works, logged as `shared_key`.
- `tool_calls` (user, client, tool, args, ok/error, latency, size) via one wrapper around `registerTool`, inserted
  after the response. **Why:** go/no-go decisions need real usage.
- Index cleanup: dropped `daily_prices_date_rate_idx`, `REINDEX` of the screen index (DB 553 → 268 MB).
- KRX key had expired unnoticed for two weeks: `krx-ingest` now returns 500 when a day fails (it returned 200).
- KIS rows go to `live_prices`, KRX rows to `daily_prices`, readers use the `prices` view. **Why:** 5-minute rewrites
  bloated the big table's index. `trading_days` (trigger-synced) feeds `available_dates` (the view counted 742k rows
  per call, ~3 s cold). `list_available_dates(limit)` → `check_available_dates(date?)`.
- Telegram: public channels read from the `t.me/s/<name>` preview (no account needed; private ones would need
  Telethon), stored in `telegram_messages`, collection shared (one row per channel, cap 50), per-user follows in
  `user_channels` (`get/set/update_my_channels`); the feed defaults to the user's channels. Added on demand with
  `add_telegram_channel` (~30-day backfill). Polled every 5 min; the feed answers from stored posts.
- Stay on the free plan (DB 279/500 MB); upgrade when PBs return weekly or the DB passes ~400 MB. Weekly encrypted
  GitHub Action backup of `public` and `auth` (35 days).

## 2026-11-16 — Tests, fixtures, validation
- Backup workflow pins the Supabase CLI (3.1.0); `latest` hit GitHub's rate limit.
- Three suites: `deno task test` (unit), `test:db` (local stack: SQL, views, triggers), `test:mcp` (every tool over
  HTTP with the MCP client). Seed with made-up stocks (9000xx) shaped per signal. Correctness and contract only; latency
  comes from `tool_calls`. A test checks `screen_stocks` (SQL) and `analyze()` (TS) agree on every metric.
- That test found new listings: `analyze()` now averages the days that exist (`avg_prior_days`, `SHORT_HISTORY`).
- Local login: `PUBLIC_SUPABASE_URL` for the issuer (local tokens are issued for 127.0.0.1, the function sees
  kong:8000). Tests use `supabase/tests/functions.env` (dummy keys) and never reach KIS, KRX or t.me.
- `deno task fixtures` saves real responses for parser tests; gitignored (public repo, KRX terms, third-party posts),
  so those tests are skipped without them.
- Ingest validation (`_shared/validate.ts`): row counts, fields, unique codes, OHLC order, 등락률 ±30%; >1% bad rows
  refuses the batch (500, nothing written). Telegram pages where <80% of posts parse are errors; stored text is never
  replaced with empty text. **Why:** a format change yields nulls, not exceptions.
- `deno task bench` (production, read-only tools, args mirroring real calls, unlogged via the shared key + `krx-bench/`
  User-Agent, timings in `_meta`). `tool_calls.timings`: per-step `[{step, start, ms}]` via `step()`.

## 2026-11-16/17 — Latency: region forwarding and fewer queries
- Every DB round trip took ~650–800 ms: the database is in `ap-south-1`, Edge Functions run near the caller (Claude's
  are `us-east-1`). `mcp` now forwards a tool request once to its copy in `DB_REGION` (`x-region`; never loops; falls
  back to local on failure). The handshake (`initialize`, `tools/list`, `ping`) is answered where it lands. Real feed
  1,510 → 517 ms, movers 2,131 → 209 ms. Ingest functions were unaffected (pg_cron runs in Mumbai).
- `tool_calls.landed_in`, `forward_ms`, `handled_in` measure the hop (one-way, NTP clocks); `client` restored for
  forwarded calls (the runtime had appended its own User-Agent).
- Fewer sequential queries: the day's status comes from its `available_dates` row; parallel steps where independent.
  A removed query saves ~40 ms; two in parallel only ~20 ms. `screen_stocks` on a no-data day errors like movers.
- KIS token read at time 0 and cached in memory; a rejected token re-reads Postgres once. Rate-limit waits on the
  live quote are recorded (`kis_rate_limited`); none seen so far.
- Cold calls: a new worker's first DB connection costs ~300–550 ms, start-up ~350 ms; free-plan workers live ≤ 150 s,
  so occasional calls always pay it (~+0.8–1 s). **Decided:** accept it for now (one routine and a few sessions;
  Claude's generation dwarfs it). Options if needed: keep-warm ping or moving to `us-east-1`.
- CI: `deno task check` and `deno task test` on every push (Deno 2.9.8, fixture tests skipped).
- `round()` in `analyze()` fixed to round like Postgres (1.005 → 1.01, halves away from zero), found via seeded
  edge-case stocks (rounding boundary, tie at the high, halted inside the window).
- `config push` is remote-only in CLI v3 and not needed (`verify_jwt` comes from `[functions.*]` at deploy).

## 2026-11-18 — Ingest runs, alerts, daily report
- `ingest_runs`: every run records itself through `monitored()` (`_shared/ops.ts`). **Why:** pg_cron reports
  "succeeded" for any sent request; failures were invisible. A failed run alerts on Telegram, at most once per job per
  hour. Rows are written at start (`ok = null`) and completed at the end; a run still running after 180 s is marked
  failed and alerted by the next run (`sweepKilled`). HTML error pages are reduced to their `<title>`.
- `pipeline-report` at 18:00 KST: KIS snapshots, KRX, Telegram, failing channels, failed runs per job; deletes runs
  older than 90 days. Telegram channel alerts fire only when a channel starts failing or recovers.
- `docs/requirements.md`: functional requirements mapped to tests, non-functional targets with baselines.
  `deno task bench:cold` (150 s between calls): cold calls cost +2.2–3.5 s end to end vs ~0.3 s warm; PERF-7 fails for
  8 of 10 tools; server-side targets hold except `screen_stocks`.
- Telegram backfill moved after the response (`EdgeRuntime.waitUntil`), progress saved per page, resumed by the cron
  if a worker dies. Adding a channel: 13.6–21.6 s → ~2 s. Feed/search say when a channel is still filling.
- KIS slowdown (calls 5–7× slower, two runs killed at 150 s): kis-ingest now calls 5 at a time at 8/s and runs in Seoul
  (`x-region: ap-northeast-2`): runs 29–115 s → 16–22 s. `kisGet` retries a request with no answer twice. krx-ingest
  also runs in Seoul with markets in parallel (loading run 126 → 46 s).
- `get_telegram_feed` shares `limit` round-robin across channels (`telegram_feed` SQL function), today's posts first.
- Telegram tagging: 15 nickname aliases for large caps; codes with letters (0001A0).
- **Re-scoped:** self-hosted for the operator and a small closed group (2 people), not a public service. **Why:** KRX's
  and KIS's terms are for personal use. `ALLOWED_USERS` gates logins (fails closed). `?key=` is the operator's.
- Every import pinned to an exact version, `deno.lock` frozen. To update: change the version, check with
  `--frozen=false`, test, commit both.

## 2026-11-19 — 수능 day, after-market, Telegram gate
- On 수능 day KRX opened at 10:00; KIS reported the pre-open auction's expected prices as today. kis-ingest now skips a
  run where most stocks are in the pre-open auction (`hour_cls_code` B). Since 2026-09-14 KRX runs a continuous
  after-market (16:00–20:00): `live_prices.close` is the latest price, KRX's 종가 is only in `daily_prices`. The KIS vs
  KRX close comparison was removed (they are meant to differ). After-hours runs at 17:05–20:05; `live_prices` days
  older than 10 days are deleted by pipeline-report. Checked: KIS's after-market rows follow real trades, `close −
  change` = the previous official close.
- `get_stock_history`: stock fields once, `days` max 120 (250 days returned 66 KB, over SIZE-2).
- `analyze_stock`'s ~1.1 s: token lookup after idle (~400 ms) + a new KIS connection (~650 ms; 125–152 ms reused).
- `tool_calls` kept without retention.
- **Telegram gate:** telegram-ingest sends new posts to Claude Haiku (prompt v5, `_shared/gate.ts`): label
  (market/noise), checked KR codes, `us_tickers`, `events`. 40 posts a run; `gated_at = null` re-gates (edit trigger;
  a new event re-gates the posts in its window only). Noise hidden unless `include_noise`. `us_symbols` from Nasdaq
  Trader, refreshed daily. New tools `find_us_stock`, `list_telegram_events`. The name matcher left production. The
  report has a gate line (posts, noise share, cost). Events are offered only to posts inside their window.
- Deploy lesson: `supabase db push` targets the local stack in CLI v3; production is `--remote` (now in CLAUDE.md).

## 2026-11-20 — Telegram from Seoul, YouTube, X, thesis design
- @stockbot was redirected to a stub page from Mumbai only (a per-country restriction). t.me is now fetched from Seoul:
  telegram-ingest runs there, and `mcp` fetches pages through its `?page=` relay (`TG_REGION`). The parser also reads
  `media_supported_cont` text, link previews and polls; 50 posts stored blank were recovered. A gate schema with
  `maxItems: 0` (no events in window) was rejected by structured outputs; such posts now get no `events` field.
- **YouTube:** transcripts from Apify (`apihq/youtube-transcript-scraper`, $0.003 each; YouTube's caption files
  refuse cloud IPs), new uploads from each channel's RSS feed. `youtube-ingest` every 5 min; a missing transcript is
  retried 15 min … 8 h, given up 48 h after upload. Four channels. MCP tools: add/list/follow channels,
  `list_youtube_videos`, `get_youtube_transcript` (parts of ~6,000 characters with `next_from_seconds`, or passages
  around a `query`; live streams reach 80–200k characters).
- **X:** `xquik/x-tweet-scraper` on Apify ($0.15 per 1,000 posts; X's API is pay-per-use). `x-ingest` every 5 min, one
  run for all accounts; tools add/list/follow and `get_x_feed` (≤ 64 KB). A failed run no longer moves
  `last_polled_at`. Bios and follower counts stored from the posts' author data. X posts gated like Telegram's.
- **Thesis tracking designed** (plan.md → Phase 4): theses and reviews stored; the server serves "what's new" as data,
  the calling LLM judges and records (`record_thesis_review`). No server-side model.

## 2026-11-21 — Telegram fetch timeouts
- Each page attempt has a 10 s timeout and one retry. When t.me itself is down, every channel stalls (10 × ~21 s), so
  polling stops after 2 channels in a row with no answer, and no channel starts after 60 s (`poll_stopped`, one alert).

## 2026-11-26 — Pipeline check; `daily_prices_screen_idx` dropped
- `thekobeissiletter` (Telegram's FAKE badge, preview off since 11-23) failed every run: set `active = false` (posts
  kept). The YouTube failures of 11-23 were an Apify outage (07:32–12:47 UTC); nothing lost.
- Dropped the 67 MB covering index (same key as the pkey; only `screen_stocks` needed its columns, 8 calls in a week).
  Checked first with production EXPLAINs: the `materialized` CTE keeps a pkey range read at 21–120-day windows
  (without it the planner picks `daily_prices_code_date_idx` from ~60 days). After: DB 321 → 254 MB, the default screen
  1.5–1.9 → 0.63 s; but two simultaneous 120-day screens hit the 8 s timeout, so `avg_days`, `sideways_days`,
  `volatility_days` are capped at 60 in the MCP schema (no real call used more than 20). Rollback: re-create the index
  (`20261011000002_screen_stocks_volume.sql`).

## 2026-11-26 — Market data: `market_quotes`, `us_quotes`, `market-ingest`
- One row per symbol, overwritten (`price` + `prev_close`; change is computed). KIS for Korean data only:
  KOSPI/KOSDAQ (real time), KRW/USD (`FX@KRW`, real time, probed 13:08–13:11), 국고채 1–30년 (fetched at 18:30 for
  the day's final value). Values rounded to the unit (KIS sends `1344.2999`).
- US from Yahoo Finance via yahoo-finance2 (`jsr:@gadicc/yahoo-finance2@4.0.5`). **Why:** real index values for every
  index wanted (KIS lacks the Dow and Russell 2000; Alpaca has no indices), yields, and any stock; one `quote()` call
  takes 1,000 symbols. Unofficial and "personal use only". The first run from Supabase (Seoul) got all 651 tickers, no
  429. Stated delays: S&P 500, Dow, Nasdaq, SOX real time; Russell, VIX, yields 15 min; stocks 15 (Nasdaq) or 20 (NYSE)
  min; ETFs 0 or 15 (`us_quotes.delay_min`). Gold and silver only as COMEX front-month futures (no spot on Yahoo),
  10 min delayed; Bitcoin real time.
- Tracked US stocks: tickers mentioned in Telegram/X posts in the last 90 days that exist in `us_symbols` (639; Nasdaq
  65% of mentions, NYSE 35%), plus fixed ETFs (`FIXED_ETFS` in `market-ingest/us.ts`). A ticker that drops out is
  deleted. Gate mistakes that are real tickers come along (`ANT`).
- Sets, each its own job in `ingest_runs` (own alert throttle): `live` (KRW/USD every 5 min 09:01–01:56 KST, plus
  KOSPI/KOSDAQ 09:00–15:40), `bonds` (18:30), `us` (every 5 min 22:03–06:58 KST, US indices, yields, stocks), `global`
  (gold, silver, Bitcoin every 10 min, every day). Cron jobs in `sql/cron.example.sql`.
- MCP: `get_market_overview` (KR/US indices, FX, KR bonds, US yields, commodities, crypto) and `get_us_quote(tickers)`
  (stored quotes only; `not_tracked` / `unknown` for the rest).
- The daily report has a `Markets` line (each set expected on the days it runs) and a YouTube line (polls, new videos,
  transcripts, videos waiting for captions). YouTube transcripts stay ungated: every channel is a market channel.

## Open
- Cold calls (+2.2–3.5 s each, every tool): keep-warm ping vs. moving the project to `us-east-1`. A ping keeps workers
  alive but probably not the DB connection (a 60 s pause already pays ~400–600 ms). Also `screen_stocks`' cold SQL
  (1.3–1.9 s vs ~0.25 s warm): `explain (analyze, buffers)` after idle. PERF-1 / PERF-6 need re-measuring with warm
  and after-idle calls apart (`deno task bench --region us-east-1`, after 15:30).
- Load benchmark (`bench:load`, not built): latency and errors at 1 → 50 concurrent calls, read-only tools, operator
  key, short runs.
- 11-30: check the `live_prices` cleanup (no day older than 10 days; on 11-26 the oldest was 11-19).
- Markets: check the first 18:00 report's `Markets` and YouTube lines (YouTube needs `pipeline-report` deployed);
  KRW/USD updates in the evening session (only daytime probed); the 18:30 국고채 value is the day's final one; Yahoo 429s
  over a full US session (Monday 11-30). Not collected: BOK base rate (ECOS key), US 2Y (Treasury.gov daily).
- Normalized chunks for Telegram posts: digests split by topic, so a filtered feed shows the relevant part (e.g.
  `event: anthropic-ipo`: 30 of 77 posts mention it only after their first 600 characters). Open: how to split, and
  whether the feed counts posts or chunks.
- Thesis tracking (plan.md → Phase 4): build 4.1 (tables, thesis tools, `add_event`).
