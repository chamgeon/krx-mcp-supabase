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

## Phase 3: More sources (2026-11-20, built)

- **YouTube:** channels' new uploads from their RSS feeds, transcripts through Apify (`youtube-ingest`, every 5 min;
  a new channel's newest 5 videos, then every upload). Tools: add, follow, list channels, list videos with a
  transcript, read a transcript in parts or by query. Transcripts are not gated yet.
- **X:** accounts' posts through Apify (`x-ingest`, every 5 min, one run for all accounts; a new account's latest 20
  posts, reposts left out), with the bio and followers. Gated like Telegram posts (same prompt, name check and
  events). Tools: add, follow, list accounts, feed with tags and filters.
- Details and numbers: log 2026-11-20.

## Phase 4: Thesis tracking (design, 2026-11-20; not started)

**Roles.** This server stays a data source. It keeps theses and their review history (a memory the calling model
doesn't have between chats) and answers "what's new for this thesis" with data. The judging is done by the LLM that
calls us, in a chat or in its client's scheduled task; it writes its verdict back, and the next review starts from
it. At most the server advises how to run a review (tool descriptions, an MCP prompt); it never generates a verdict,
a digest or an opinion itself, and runs no model for it. So the first rule holds: no insight features on our side.

**Goal.** The caller doesn't start from scratch each day: it can read what it (or the user) concluded before, on what
evidence, how to tell if it was right, and what has come in since.

**Events are the glue.** An event (`telegram_events`) says what a post is *about* (`amd-short-report`); a thesis is a
*claim* about how it turns out ("the AMD sell-off is overdone; back above $520 by 12-18"). A thesis links to events,
KR codes and US tickers, the same tags the gate writes on Telegram and X posts, so "new evidence for this thesis" is
a query over tags already there, with no new search logic.

### 1. Store theses and reviews (schema)

- `theses`, one row per claim, as the caller writes it:
  - the statement, its direction and horizon, and the date it was made;
  - the evidence it started from (links to posts, videos, price rows);
  - verification conditions: what would confirm it, what would refute it, by when; measurable where possible (a
    price level, an earnings figure, an official statement);
  - links: `events`, `stock_codes`, `us_tickers`;
  - status (`active`, `confirmed`, `refuted`, `expired`, `closed`) and confidence, both set by the caller;
  - owner (`user_id`): private to that user. No tool lists or reads another user's theses (as with followed
    channels); the operator's `?key=` connection has no user, so it can't add or read any.
- `thesis_reviews`, one row per review the caller records: verdict (strengthened / weakened / refuted / no change),
  its reasoning, confidence after, and the evidence it cites (each linked). The server stores it as given; it checks
  only that cited evidence exists.

### 2. Tools (data in, data out)

- `add_thesis`: stores a thesis as the caller structured it (statement, conditions, links). When no event covers it,
  the answer says so and suggests `add_event`.
- `add_event(id, description, active_from)`: any logged-in user adds an event. Adding it re-gates the posts in its
  window, so earlier evidence gets tagged too (~$0.05 per 1,000 posts). Events stay **shared**, unlike theses: the
  gate tags everyone's posts with them, and `list_telegram_events` shows them all. Guards, since one user's event
  costs re-gating and changes tags everyone sees:
  - `active_from` at most 30 days back (bounds the re-gate);
  - a few new events per user a day;
  - no duplicate ids; the answer shows existing events whose description is close, so the caller reuses one;
  - `added_by` recorded on the event; editing or removing one stays the operator's (an edit re-gates nothing by
    itself, see 20261119000001).
- `list_theses`, `get_thesis` (the thesis and its review history).
- `get_thesis_updates(thesis, since?)`: the data a review needs, since the last recorded review by default:
  - gated market posts (Telegram, X) with its events, stocks or tickers;
  - YouTube passages that mention them (transcript search, until transcripts are gated);
  - KR price moves from `daily_prices` / `live_prices`;
  - **facts about its conditions**, computed, not judged: "close crossed 520 on 12-02", "deadline 12-18 passed".
  Size-capped like the feeds (64 KB), with links to everything.
- `record_thesis_review(thesis, verdict, reasoning, confidence, evidence, status?)`: writes the caller's conclusion,
  and closes the thesis when the caller says it's confirmed, refuted or expired.

### 3. Daily review: the caller's schedule, our advice

Scheduling belongs to the client: a Claude routine or a ChatGPT scheduled task that says "review my theses" at
17:00 KST calls `list_theses` → `get_thesis_updates` → `record_thesis_review` for each one. (This answers "can a
scheduled reminder reach the data?": yes, through the MCP, if the client's scheduled tasks can use connectors; to be
checked per client.) We help it run well without running it:

- tool descriptions that say what a good review records (cite evidence, compare against the stated conditions, say
  when nothing changed);
- an MCP prompt (`review_theses`) with that workflow, for clients that support prompts;
- `get_thesis_updates` says when there's nothing new, so a scheduled run can skip that thesis cheaply.

No server-side digest: the caller reports to the user in its own channel (chat, its scheduled-task notification).

### 4. Gaps to close (data we don't have yet)

| Gap | Why it matters | Fix |
|---|---|---|
| No US prices | US theses can't be checked against price moves, only news | A daily US close for the tickers theses reference |
| YouTube not gated | Videos carry no event or stock tags; found only by text search | Gate transcripts in chunks (also helps the feed) |
| No 뉴스·공시·리서치 | Theses only see Telegram, X and YouTube | DART 공시 API first (free, official), news later |

### Order

1. Phase 4.1: tables, `add_thesis`, `list_theses`, `get_thesis`, `record_thesis_review`, `add_event`. ~1 session.
2. Phase 4.2: `get_thesis_updates` (evidence and condition facts), the `review_theses` prompt, and a check that a
   scheduled task in Claude (and ChatGPT) can run the review through the MCP. ~1 session.
3. Then each gap on its own: YouTube gating, DART, US prices.

### Decided (2026-11-20)

1. Users add events through a tool (`add_event`, with the guards above); events stay shared.
2. Theses and their reviews are private to their user.

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
