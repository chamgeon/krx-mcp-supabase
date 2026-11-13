# kismcp Plan

## Rules

- Data comes from the MCP. Insight comes from the PB, so don't build "insight" features.
- Build a feature only after users ask for it, or the logs show they need it.
- Scraping is fine if it's polite: low request rate, cache results, back off on errors, show short excerpts plus a link.

## Phase 0: Know who uses what

1. **Usage logging**
   - Add a `tool_calls` table: `ts`, `user_id`, `tool`, `args`, `latency_ms`, `response_bytes`, `error`.
   - Wrap `registerTool` once so every tool logs. Write the row without waiting for it.
   - Save a weekly report query: calls per tool, unique users, repeat users, error rate.
2. **Login**
   - Use the MCP login flow (OAuth) with Supabase Auth as the auth server.
   - Offer Kakao and Google login.
   - Check how well ChatGPT and Claude each support it.
   - Keep the old shared `?key=` working for a few weeks. Its responses tell users to reconnect with login.
3. **Per-user preferences**
   - Add a `user_prefs` table keyed by `user_id` (Telegram channels first).
   - Add a tool to view or change them, e.g. `set_my_channels`.
4. **Feedback log**
   - A simple doc of interview notes and feature requests.

## Phase 1: Telegram data

1. **Get the channel list**
   - Ask the PBs which channels they actually read, and whether each one is public or private.
2. **Collect public channels**
   - Scrape the `t.me/s/<channel>` web preview from an Edge Function cron job.
   - This needs no Telegram account and fits the current stack.
3. **Collect private channels (if needed)**
   - Run a user-account client (Telethon) on a small always-on worker, with a dedicated account.
   - Join channels slowly to avoid getting the account banned.
4. **Storage**
   - Add a `telegram_messages` table: `channel`, `msg_id`, `ts`, `text`, `views`, `link`, `stock_codes[]`.
   - Fill `stock_codes` by matching message text against the stock name list.
   - Use the `pgroonga` or `pg_trgm` extension for Korean search.
5. **Tools**
   - `get_telegram_feed(channels?, since?)`: defaults to the user's own channels.
   - `search_telegram(query, since?)`
   - Attach related messages to `get_daily_movers` and `analyze_stock`.
6. **Validate**
   - Check whether usage is repeated and weekly.
   - Ask users what they wanted but couldn't get.

## Backlog (build only on user request)

- Investor flows (수급): foreign, institutional and retail net buying, short selling, margin balance (KIS API)
- DART disclosures attached to movers
- DART financials and valuation metrics
- Questions to ask for a given industry, for 비상장 deal review (still unclear what value the MCP adds)
- Watchlist briefing
- Event calendar

## Dropped

- Knowledge graph and "insight" generation: users didn't see the value
- Hypothesis backtesting (e.g. "반도체 down → 바이오 up"): users said the numbers alone mislead
