# kismcp Plan

> **Re-scoped 2026-11-18:** a self-hosted tool for personal use or a small closed group (allowlisted accounts), not a
> service for PBs at other firms. KRX's and KIS's terms are written for personal use and restrict passing data on, and
> redistributing Telegram posts to professionals is the riskiest part. The phases below are kept as the history of
> how the features came about; "users" now means the group on a deployment. See README → Scope & data.

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

## Phase 2: Telegram feed quality (2026-11-19)

Problems seen in the data (14 days, 6 channels, ~90 posts/day):
- One busy channel (insidertracking, ~83 posts/day) fills a daily reader's feed; fine for an hourly reader.
- 13% of posts have no text (images, stickers, polls); a few are chatter ("피드 싹 갈아엎는중입니다"). Short posts are
  mostly real headlines, so length can't be the filter.
- Long digests (ehdwl's median post is 2,402 chars) are cut by the feed's `max_chars`, which the calling model sets to
  600–900 in ~40% of calls. Storage keeps the full text.

Dropped for now: splitting posts into sections or chunks (the formatting differs too much between channels for rules
to hold up).

1. **Experiment, local only (no production tables)**
   - Export recent posts from production (read-only) to a local file.
   - A local script runs one Claude Haiku 5.5 call per post, with structured output:
     - `label`: `market` or `noise`. Noise is defined narrowly (chatter, channel housekeeping, filler); unsure counts
       as `market`. No importance score: without a rubric it would be arbitrary.
     - `companies`: name as written, market (KR/US), code or ticker. The script checks every guess: KR against the
       stock list (code exists and matches the name, else lookup by name), US against the Nasdaq + NYSE symbol list.
       Rejected guesses stay in the raw output.
     - `events`: only ids from a hand-written event list (id + one-line description), e.g. Anthropic's IPO.
   - Posts with no text are labeled noise without an LLM call.
   - Report: label counts per channel and the noise posts to review; LLM tags vs. today's `stock_codes` (agree, LLM
     only, old tagger only); events found; rejected guesses; tokens and cost.
2. **Decide after reviewing the report**
   - Whether the noise label is trustworthy enough to hide posts.
   - Whether LLM tags replace the name-matching tagger, or are added to it.
   - Whether event tagging is worth keeping, and who adds events (operator only, or users).
3. **Adopted (2026-11-19, prompt v5)**: built as below; the name matcher now lives only in the experiment
   (scripts/name_matcher.ts).
   - No tags table: columns on `telegram_messages` (label, KR codes in `stock_codes`, US tickers, events, prompt
     version, gated_at), filled by telegram-ingest; an event is a `telegram_events` row, and adding one re-tags the
     posts in its window.
   - Noise is hidden from the feed and search; `include_noise: true` shows it for review.
   - US firms: a daily `us_symbols` table from Nasdaq's symbol files (Nasdaq + NYSE). Feed and search take a US ticker;
     the calling model turns Korean names (엔비디아) into tickers. `resolve_tag` only checks tickers and English names
     against the symbol list. No alias table built from LLM output: it would keep wrong pairings for good.
   - Cost at today's volume: ~$0.60/month (Haiku 5.5), plus ~$0.05 per new event's re-tag. Runs in telegram-ingest, so
     no added latency for users. Needs an Anthropic API key as a Supabase secret; CAP-6 ($0/month) no longer holds.
   - Still open: the feed's volume problem for daily readers (the gate removes noise but doesn't rank).

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
