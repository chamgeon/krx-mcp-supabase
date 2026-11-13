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
