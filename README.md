# krx-mcp-supabase

An MCP server that gives ChatGPT / Claude intraday and end-of-day data and quantitative screening for every KOSPI and
KOSDAQ stock.
It runs entirely on the Supabase free plan: scheduled Edge Functions load daily data into Postgres, and a third Edge
Function serves it over MCP.

## Scope & data

- **Self-hosted, for personal use or a small closed group.** Each deployment is run by its operator for themselves and,
  at most, a few people they choose. It is not a public service, and this repo doesn't host one.
- **No data ships with this repo.** No prices, no Telegram posts, no keys: test data is made up, and real API responses
  used in parser tests stay local (gitignored).
- **Each deployment uses its own access:** its own KRX and KIS API keys and its own Telegram setup.
- **Access is limited to an allowlist.** Users log in with OAuth, and only accounts listed in `ALLOWED_USERS` get in
  ([Login](#7-login-oauth)).
- **The operator is responsible for the data sources' terms** for everyone they let in. KRX's and KIS's terms are
  written for personal use and restrict passing data on to third parties; Telegram posts belong to their channels.

```
KIS Open API ──(pg_cron, every 5 min + after close)──> kis-ingest ─┐  same day, provisional
                                                                   ├─> Postgres ──> mcp ──> ChatGPT / Claude
KRX Open API ──(pg_cron, next morning)──────────────> krx-ingest ─┘  official, replaces KIS rows
```

KRX only publishes a trading day's data after the close, often the next morning. So the current day comes from the
한국투자증권 (KIS) Open API: a whole-market snapshot every 5 minutes during the session and again after the close. It's
replaced with KRX's official numbers once KRX publishes them.

All numbers come from SQL and TypeScript over stored data. The LLM is only used on the client side, e.g. to search the
news for why a stock moved.

## Tools

| Tool | Returns |
|---|---|
| `get_daily_movers(date?)` | Daily movers report: **sheet1** 등락률 ≥ +15%, **sheet2** 등락률 ≥ +7% and 거래대금 ≥ 500억 (excluding sheet1), both sorted by 등락률, **sheet3** 일봉/주봉/월봉 chart URLs |
| `screen_stocks(date?, filters…)` | Every stock matching a set of optional filters, with all metrics per row (see below) |
| `analyze_stock(stock, date?)` | Quantitative profile of one stock plus a list of triggered signals; during the session also a live KIS quote |
| `get_stock_history(code, days)` | Recent daily OHLCV rows for one stock |
| `find_stock(name)` | 종목명 → 종목코드 |
| `check_available_dates(date?)` | Without a date: total, first and last trading day. With a date: whether it has data (final or provisional), or the nearest trading days around it |
| `add_telegram_channel(channel)` | Starts collecting a public Telegram channel (needs a `t.me/s/<name>` preview), returns the latest posts after one page, and backfills ~30 days in the background (feed/search note a channel that is still filling) |
| `list_telegram_channels()` | Collected channels with post counts, latest post and poll status |
| `get_telegram_feed(channel?, stock?, since?, all_channels?)` | Recent posts from the user's channels (or all), newest first, with links and the stocks they mention |
| `search_telegram(query, channel?, since?)` | Posts containing all the words, with a snippet and link |
| `get_my_channels()` | Channels the logged-in user follows (their default feed) |
| `set_my_channels(channels)` | Replaces the user's followed channels; collects new ones first |
| `update_my_channels(add?, remove?)` | Follows / unfollows channels |
| `add_youtube_channel(channel)` | Starts collecting a YouTube channel (@handle, link or `UC…` id): its newest 5 videos now, every new upload after; transcripts follow within ~10 min. Up to 20 channels |
| `get_my_youtube_channels()` | YouTube channels the user follows, with transcript counts and the latest video |
| `list_youtube_channels()` | Collected YouTube channels with videos with a transcript, videos still waiting for one, the latest video and poll status |
| `update_my_youtube_channels(add?, remove?)` | Follows / unfollows YouTube channels (titles of collected channels work too) |
| `list_youtube_videos(channel?, query?, days?, limit?)` | Recent videos **with a transcript** from the user's channels (or all), newest first (videos still waiting are only counted); with `query`, only videos that mention it, with timed excerpts |
| `get_youtube_transcript(video, from_seconds?, max_chars?, query?)` | A transcript one part at a time (~6,000 characters, `[m:ss]` each minute, `next_from_seconds` for the next part), or only the passages around `query` |
| `add_x_account(account)` | Starts collecting an X account (@handle or link): its latest 20 posts now (a few seconds), then new ones every 5 min; reposts left out. Up to 20 accounts |
| `get_my_x_accounts()` / `update_my_x_accounts(add?, remove?)` | X accounts the user follows (their default feed); follows / unfollows them |
| `list_x_accounts()` | Collected X accounts: name, bio, followers, verified, profile link, post counts, latest post and poll status |
| `get_x_feed(account?, query?, days?, limit?)` | Recent posts from the user's accounts (or all), newest first (default 30, at most 100, within 3 days by default): text, quoted post, chart image links, views, likes, link; `query` keeps posts with every word. The answer stays ≤ 64 KB (~90 English posts, ~40–50 Korean) and says how many it left out |

### `screen_stocks`

Runs as a single Postgres function (`public.screen_stocks`) over the whole market. Every filter is optional, and
lookback windows, thresholds and the analysis date are all parameters.

| Signal | Metric |
|---|---|
| Daily move / size | 등락률, 거래대금, 거래량, 시가총액, market |
| 거래대금 / 거래량 spike | today ÷ average of the prior N trading days |
| Consecutive increases | days in a row with higher 거래대금; higher / lower close |
| Sideways + rising 거래대금 | high–low range of the last N days, and recent vs. earlier 거래대금 inside that box |
| Breakouts | close above the highest high of the prior 20 / 60 / 120 trading days |
| Volatility | standard deviation of daily 등락률 |

Example: 거래량 at least 3× its prior 5-day average:

```json
{ "date": "2026-10-08", "avg_days": 5, "min_volume_ratio": 3 }
```

### `analyze_stock`

Accepts a 종목코드 or a name, and returns:
- returns over 1/5/10/20/60/120 days
- 거래대금 and 거래량 vs. prior averages, and spike days
- MA5/20/60/120 with alignment (정배열/역배열) and 5/20 crosses
- 20/60/120-day breakouts, volatility (σ of 등락률, ATR14) and up/down streaks
- the consolidation box and price vs. 거래대금 divergence

Triggered conditions come back as a `signals` list (`TRDVAL_SPIKE`, `BREAKOUT_120D`, `BOX_WITH_RISING_TRDVAL`, …).

## Setup

### 1. API keys

#### KRX

1. Sign up at https://openapi.krx.co.kr and apply for an API 인증키.
2. Apply for these two services (서비스 이용신청):
   - 주식 → **유가증권 일별매매정보** (`stk_bydd_trd`)
   - 주식 → **코스닥 일별매매정보** (`ksq_bydd_trd`)
3. Approval usually comes the same day.

KRX's terms don't allow passing the data on to third parties, so each deployment should use its operator's own key
(see [Scope & data](#scope--data)).

#### KIS (한국투자증권)

1. Open a 한국투자증권 account, then apply for Open API at https://apiportal.koreainvestment.com (KIS Developers).
2. Note the **App Key** and **App Secret** of your 실전투자 app.

New app keys have a lower per-second call limit for the first few days. kis-ingest backs off and retries when it hits
the limit.

### 2. Supabase project

Create a free project at https://supabase.com (Seoul region recommended) and note its **project ref** (the `xxxx` in
`https://xxxx.supabase.co`). Then, with the Supabase CLI (2.117+):

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push --remote   # tables, indexes and the screen_stocks function (CLI v3: plain `db push` targets the local stack)
```

No `supabase config push` is needed: `verify_jwt = false` for the functions comes from `supabase/config.toml` when they
are deployed (step 4). Note that under CLI v3 `config push` always targets the linked (production) project and writes
every auth/database/storage setting `config.toml` declares; run `supabase config diff` first if you ever use it.

### 3. Secrets

Generate two random strings (e.g. `openssl rand -hex 24`), one for the ingest jobs and one for the operator's key
(`?key=` access for your own scripts and benchmarks, no login):

```bash
supabase secrets set \
  KRX_API_KEY=<KRX key> \
  KIS_APP_KEY=<KIS app key> \
  KIS_APP_SECRET=<KIS app secret> \
  INGEST_SECRET=<random string 1> \
  MCP_ACCESS_KEY=<random string 2>
```

`ALLOWED_USERS` (who may log in) is set after the first login; see [Login](#7-login-oauth).

For pipeline alerts and the daily report on Telegram: create a bot with @BotFather, send it any message, read your chat
id from `https://api.telegram.org/bot<TOKEN>/getUpdates` (`message.chat.id`), then:

```bash
supabase secrets set TELEGRAM_BOT_TOKEN=<bot token> TELEGRAM_CHAT_ID=<chat id>
```

Without them nothing is sent (the message goes to the function logs).

For the Telegram gate (telegram-ingest labels each post market or noise, hides noise, and tags KR stocks, US tickers
and events with Claude Haiku; about $0.40/month at ~90 posts a day): an Anthropic API key, from a key you create for
this deployment.

```bash
supabase secrets set ANTHROPIC_API_KEY=<Anthropic API key>
```

Without it posts are stored and shown, but not labeled or tagged. Events to tag are rows of `telegram_events`. An
event applies only to posts inside its window (`active_from` to `active_to`); adding one re-tags the posts in it
(SQL below). Editing an event re-tags nothing by itself.

To gate the posts stored before the gate at once (instead of 40 per 5-minute run), call `telegram-ingest?gate=500`
until its `gate.left` is 0.

Telegram hides some channels' web previews from some countries (e.g. `t.me/s/stockbot` redirects from Mumbai, loads
from Seoul). With the database in Mumbai, fetch t.me from Seoul: the telegram-ingest cron sends `x-region:
ap-northeast-2` (`sql/cron.example.sql`), and `mcp` (which runs next to the database) fetches its pages through
telegram-ingest's `?page=` relay there:

```bash
supabase secrets set TG_REGION=ap-northeast-2
```

Without it `mcp` fetches t.me from wherever it runs, and such channels can't be added there ("no public web preview").

#### Telegram gate: useful SQL

Run in the SQL editor, or `supabase db query --remote "<sql>"`. Re-gating is always `gated_at = null`: telegram-ingest
gates those posts again, newest first, 40 per run (or at once with `?gate=500`).

```sql
-- Events: add one (re-tags the posts in its window; active_from defaults to 7 days before now); '' is an apostrophe
insert into telegram_events (id, description, active_from)
values ('anthropic-ipo', 'Anthropic''s IPO (상장): listing, pricing, demand, first trading day, valuation, effect on other stocks', '2026-11-01');
-- change what it covers: an edit re-tags nothing, so reset the posts in its window yourself; end it (posts after
-- active_to aren't offered it; tagged posts keep the tag); list with post counts
update telegram_events set description = '...' where id = 'anthropic-ipo';
update telegram_messages set gated_at = null where ts >= (select active_from from telegram_events where id = 'anthropic-ipo');
update telegram_events set active_to = now() where id = 'anthropic-ipo';
-- an end in the past: the posts already tagged after it keep the tag (an edit re-gates nothing), so remove it
update telegram_messages set events = array_remove(events, 'anthropic-ipo')
where events @> array['anthropic-ipo'] and ts >= (select active_to from telegram_events where id = 'anthropic-ipo');
select e.id, e.active_from, e.active_to, count(m.msg_id) as posts
from telegram_events e left join telegram_messages m on m.events @> array[e.id]
group by e.id order by e.created_at desc;

-- Ungated posts: how many, and which (the order the gate takes them)
select count(*) from telegram_messages where gated_at is null;
select username, msg_id, ts, left(text, 80) as text from telegram_messages where gated_at is null order by ts desc limit 50;
-- the gate per run: gated, backlog left, errors
select started_at, summary->'gate'->>'gated' as gated, summary->'gate'->>'left' as left_ungated, summary->'gate'->'errors' as errors
from ingest_runs where job = 'telegram-ingest' order by started_at desc limit 10;

-- Noise: the share per channel, and the posts to review (also: get_telegram_feed with include_noise: true)
select username, count(*) filter (where label = 'noise') as noise, count(*) as posts from telegram_messages group by 1 order by 3 desc;
select username, msg_id, has_media, left(text, 100) as text from telegram_messages
where label = 'noise' and btrim(text) <> '' order by ts desc limit 50;

-- US symbols: when the list was last refreshed, and whether a ticker is listed
select max(updated_at), count(*) from us_symbols;
select * from us_symbols where ticker = 'NVDA' or name ilike '%nvidia%';

-- Re-gate: after a new listing appears (its earlier mentions were rejected), after changing an alias list or the
-- prompt, or one channel
update telegram_messages set gated_at = null where ts >= '2026-11-12' and text ~* '앤트로픽|anthropic';
update telegram_messages set gated_at = null where ts >= now() - interval '30 days';
update telegram_messages set gated_at = null where username = 'insidertracking';
```

#### YouTube transcripts

`youtube-ingest` polls each collected YouTube channel's RSS feed every 5 minutes and fetches the transcripts of new
videos through an [Apify](https://apify.com) actor (`apihq/youtube-transcript-scraper`, about $0.003 a transcript, a
failed one not charged). YouTube refuses caption requests from cloud IPs, so the transcripts can't be fetched from
Supabase directly. Create an Apify account, copy its API token (Settings → API & Integrations), then:

```bash
supabase secrets set APIFY_API_KEY=<Apify API token>
```

Without it videos are still collected, with their title and description, and wait for a transcript.

Channels are added by hand, by channel id (`UC…`: on the channel page, Share → Copy channel ID, or the
`<meta itemprop="identifier">` in its page source). `language` is the transcript track asked for:

```sql
insert into youtube_channels (channel_id, language) values
  ('UCw8pcmyPWGSik7bjJpeINlA', 'ko'),   -- 기릿의 주식노트
  ('UCOB62fKRT7b73X7tRxMuN2g', 'ko'),   -- 박종훈의 지식한방
  ('UC_JJ_NhRqPKcIOj5Ko3W_3w', 'ko'),   -- 오선의 미국 증시 라이브
  ('UCRCNBeNS8MrOwFV6h6Yjemw', 'ko');   -- 시황맨TV
```

A new channel's first poll keeps its newest 5 videos; after that every new upload (Shorts are skipped). A transcript
that isn't there yet (captions take a while after upload; a live stream has none until it ends) is retried after
15 min, 30 min, 1 h … up to every 8 h, and given up on 48 h after the video was published.

```sql
-- Videos and their transcript state
select c.title, v.published_at, v.title, v.transcript_status, length(v.transcript) chars, v.attempts, v.last_error
from youtube_videos v join youtube_channels c using (channel_id) order by v.published_at desc limit 20;

-- Try a video's transcript again now
update youtube_videos set transcript_status = 'pending', next_attempt_at = now() where video_id = '<id>';

-- Stop polling a channel (its videos stay)
update youtube_channels set active = false where channel_id = '<UC…>';
```

#### X (Twitter) posts

`x-ingest` collects posts from X accounts through the Apify actor `xquik/x-tweet-scraper` (same `APIFY_API_KEY`):
~$0.15 per 1,000 posts plus ~$0.00007 a run, one run every 5 minutes for all accounts (~$0.55 a month, then the
posts). A new account gets its latest 20 posts once; after that each run asks for posts since the last poll.
Reposts are left out in the actor (not paid for); posts, quotes and the author's replies are kept, with image URLs.
Accounts are added with the `add_x_account` tool, or by hand (the next run backfills them):

```sql
insert into x_accounts (username) values ('charliebilello');
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions automatically.

### 4. Deploy the functions

```bash
supabase functions deploy kis-ingest
supabase functions deploy krx-ingest
supabase functions deploy telegram-ingest
supabase functions deploy youtube-ingest
supabase functions deploy x-ingest
supabase functions deploy mcp
supabase functions deploy pipeline-report
```

Each deploy reads `[functions.<name>] verify_jwt = false` from `supabase/config.toml`: the ingest functions check their
own secret and `mcp` handles login itself, so Supabase's own JWT check must stay off.

### 5. Load data

Load the last week, which also tests the KRX key:

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/krx-ingest" \
  -H "x-ingest-secret: <INGEST_SECRET>"
```

The response lists each date with its row count: ~2,700 for a trading day, `0` for a holiday, or an error message
(e.g. a KRX service that isn't approved yet).

Backfill history for the 60/120-day metrics. It costs 2 KRX calls per weekday, and the limit is 10,000 per day:

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/krx-ingest?from=20260101&to=20261010" \
  -H "x-ingest-secret: <INGEST_SECRET>"
```

If a long range times out, split it into ~1-month chunks.

### 6. Schedule daily loads

1. In the dashboard, enable the **pg_cron** and **pg_net** extensions (Database → Extensions).
2. Copy `sql/cron.example.sql` to `sql/cron.sql` (git-ignored) and fill in `<PROJECT_REF>` and `<INGEST_SECRET>`.
3. Run it in the SQL Editor.

It schedules:

- **kis-ingest** every 5 minutes from 09:05 to 15:20 KST on weekdays: an intraday snapshot of every stock (~93 KIS
  calls, under 1.5 minutes). It skips the opening auction and the 15:20–15:30 closing auction.
- **kis-ingest** at 15:40, 16:00 and 18:00 KST on weekdays: the end-of-day snapshot. The later runs pick up
  after-hours trading (시간외 종가 / 단일가) and retry a failed run. Holidays are detected through KIS and skipped.
- **telegram-ingest** every 5 minutes: new posts from every collected Telegram channel.
- **krx-ingest** every 30 minutes from 07:00 to 08:30 KST, daily: replaces the previous day with KRX's official data
  once it's published, and fills in any recent day that's missing or still provisional.

### 7. Login (OAuth)

Allowlisted accounts log in with Google, and Supabase Auth acts as the OAuth 2.1 server for MCP clients. One-time
setup:

1. **Consent page.** `web/oauth/consent.html` is where users sign in and approve the connection. Fill in your project
   URL and publishable key at the top of its script. Then, in the GitHub repo, open Settings → Pages and set Source to
   **GitHub Actions**, and push. `.github/workflows/pages.yml` publishes `web/` to
   `https://<owner>.github.io/<repo>/oauth/consent.html`.
2. **Supabase → Authentication → OAuth Server:** turn it on, turn on **Allow dynamic OAuth apps** (MCP clients
   register themselves), and set Authorization path to `/oauth/consent.html`.
3. **Supabase → Authentication → URL Configuration:**
   - Site URL: `https://<owner>.github.io/<repo>`
   - Redirect URLs: add `https://<owner>.github.io/<repo>/oauth/**`
4. **Google login:**
   - In Google Cloud Console, create a project and an OAuth consent screen: External, basic scopes only. Leave it in
     **Testing** and add the group's Google accounts as test users, so nobody else can sign in at all.
   - Create an OAuth client (Web application) with the authorized redirect URI
     `https://<PROJECT_REF>.supabase.co/auth/v1/callback`.
   - Paste its client ID and secret into Supabase → Authentication → Sign In / Providers → Google.

5. **Supabase → Authentication → Sign In / Providers:** turn off **Allow new users to sign up** once everyone in the
   group has logged in once.
6. **Allowlist.** After each person's first login, find their user id (Supabase → Authentication → Users, or
   `select id, email from auth.users`) and set the list (ids or emails, comma-separated):
   ```bash
   supabase secrets set ALLOWED_USERS=<your user id>,<another user id>
   ```
   Secrets apply to new function instances; redeploy `mcp` to be sure. With no list set, every login is refused
   (403); the first login creates the account even so, which is how you get the id.

The MCP function verifies each access token locally against the project's public keys (`/auth/v1/.well-known/jwks.json`),
then checks the user against `ALLOWED_USERS`.

### 8. Connect a chatbot

The MCP endpoint (Streamable HTTP) is:

```
https://<PROJECT_REF>.supabase.co/functions/v1/mcp
```

The client opens the login page the first time it connects.

- **ChatGPT**: Settings → Apps & Connectors → Advanced → enable Developer mode, then create a connector with the URL.
- **Claude**: Settings → Connectors → Add custom connector.
- **Testing**: `npx -y @modelcontextprotocol/inspector`

The operator's URL (`…/mcp?key=<MCP_ACCESS_KEY>`) works without login, for your own scripts (`deno task bench`).

After a tool's parameters change, refresh the connector so the client sees the new schema.

Example prompt:

> get_daily_movers로 최신 거래일 데이터를 가져와서 엑셀로 만들어줘.
> Sheet 1/2는 툴 결과 그대로 쓰고, 각 종목마다 웹 검색으로 "왜 올랐는지"를 상세하게 적어줘
> (재료/뉴스, 공시, 테마, 수급). Sheet 3에는 차트 URL을 넣어줘.

## Tests

Three suites, from fastest to most complete. None of them touch production, KIS, KRX or Telegram.

| Command | What | Needs |
|---|---|---|
| `deno task test` | Unit tests next to the code (`*_test.ts`): `analyze()`, Telegram parsing, the gate's checks, KIS helpers (and the experiment's name matcher) | nothing |
| `deno task test:db` | `screen_stocks`, the `prices` / `available_dates` views, the `trading_days` triggers, and `screen_stocks` vs. `analyze()` agreement (`supabase/tests/db_test.ts`) | local stack |
| `deno task test:mcp` | Every MCP tool over HTTP with the official MCP client, auth (401, `?key=`, a real user token), usage logging (`supabase/tests/mcp_test.ts`) | local stack + served function |

CI (`.github/workflows/test.yml`) runs `deno task check` (typecheck of every function and script) and `deno task test`
on every push and pull request.

```sh
open -a Docker                  # Docker Desktop runs the local stack
supabase start                  # local Postgres/Auth/Edge runtime; applies migrations and supabase/seed.sql
supabase functions serve mcp --env-file supabase/tests/functions.env   # second terminal, for test:mcp
deno task test && deno task test:db && deno task test:mcp
supabase stop                   # when done
```

The local database holds only `supabase/seed.sql`: made-up stocks (codes 9000xx), each shaped to trigger one signal,
plus two Telegram channels. `supabase db reset` restores it. `supabase/tests/functions.env` holds dummy keys only;
never serve tests with `supabase/.env`, which has the real ones.

## Backups

The free plan has no backups, so `.github/workflows/backup.yml` runs every Monday at 03:00 KST (or by hand: Actions →
**backup** → Run workflow). It dumps the `public` schema and data plus the `auth` users, encrypts the bundle, and keeps
it as a workflow artifact for 35 days.

One-time setup, in the GitHub repo → Settings → Secrets and variables → Actions:
- `SUPABASE_DB_URL`: Supabase Dashboard → Connect → **Session pooler** connection string, with the database password
  filled in. Percent-encode special characters in the password.
- `BACKUP_PASSPHRASE`: a long random string (e.g. `openssl rand -base64 32`). Keep a copy in your password manager;
  without it the backups can't be opened.

Restore into a new project (`$DB_URL` = its connection string):

```bash
gpg -d db-YYYY-MM-DD.tar.gz.gpg | tar xz -C restore/
psql "$DB_URL" -v ON_ERROR_STOP=1 -f restore/schema.sql
psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -c 'SET session_replication_role = replica' \
  -f restore/auth_data.sql -f restore/data.sql
```

`session_replication_role = replica` skips triggers and foreign-key checks while loading, so table order doesn't
matter. Then redeploy the Edge Functions, set the secrets, and recreate the cron jobs (Setup steps 3–6).

## Warnings

- **Keep the operator's `?key=` URL private.** Anyone who has it can call the server without logging in or being on
  the allowlist; its calls are logged as `shared_key`.
- **Free-plan pause.** Supabase pauses projects that are inactive for 7 days. The daily cron job keeps the project
  active. If it does pause, restore it from the dashboard; the data is kept.
- **Storage.** A year of history takes ~270 MB of the 500 MB free database, and nothing deletes old rows yet.
- **KRX key expires yearly.** When it does, `krx-ingest` fails with 401 and the days stay provisional (KIS data). Renew
  it at openapi.krx.co.kr, then backfill with `?from=…&to=…`.

## Docs

- [`docs/plan.md`](docs/plan.md): what to build next
- [`docs/log.md`](docs/log.md): what was done and why
- Usage: `select * from tool_usage_weekly order by week desc, calls desc;` (one row per tool call in `tool_calls`)
