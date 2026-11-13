# krx-mcp-supabase

An MCP server that gives ChatGPT / Claude intraday and end-of-day data and quantitative screening for every KOSPI and
KOSDAQ stock.
It runs entirely on the Supabase free plan: scheduled Edge Functions load daily data into Postgres, and a third Edge
Function serves it over MCP.

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

KRX's terms don't allow passing the data on to third parties, so each user should register their own key.

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
supabase db push            # tables, indexes and the screen_stocks function
supabase config push        # verify_jwt = false for both functions
```

### 3. Secrets

Generate two random strings (e.g. `openssl rand -hex 24`), one for the ingest job and one for the MCP URL:

```bash
supabase secrets set \
  KRX_API_KEY=<KRX key> \
  KIS_APP_KEY=<KIS app key> \
  KIS_APP_SECRET=<KIS app secret> \
  INGEST_SECRET=<random string 1> \
  MCP_ACCESS_KEY=<random string 2>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions automatically.

### 4. Deploy the functions

```bash
supabase functions deploy kis-ingest
supabase functions deploy krx-ingest
supabase functions deploy mcp
```

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
- **krx-ingest** every 30 minutes from 07:00 to 08:30 KST, daily: replaces the previous day with KRX's official data
  once it's published, and fills in any recent day that's missing or still provisional.

### 7. Login (OAuth)

Users log in with Google, and Supabase Auth acts as the OAuth 2.1 server for MCP clients. One-time setup:

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
   - In Google Cloud Console, create a project and an OAuth consent screen: External, basic scopes only, then
     **Publish app**.
   - Create an OAuth client (Web application) with the authorized redirect URI
     `https://<PROJECT_REF>.supabase.co/auth/v1/callback`.
   - Paste its client ID and secret into Supabase → Authentication → Sign In / Providers → Google.

The MCP function verifies each access token locally against the project's public keys (`/auth/v1/.well-known/jwks.json`).

### 8. Connect a chatbot

The MCP endpoint (Streamable HTTP) is:

```
https://<PROJECT_REF>.supabase.co/functions/v1/mcp
```

The client opens the login page the first time it connects.

- **ChatGPT**: Settings → Apps & Connectors → Advanced → enable Developer mode, then create a connector with the URL.
- **Claude**: Settings → Connectors → Add custom connector.
- **Testing**: `npx -y @modelcontextprotocol/inspector`

The old shared URL (`…/mcp?key=<MCP_ACCESS_KEY>`) still works during the transition, with no login.

After a tool's parameters change, refresh the connector so the client sees the new schema.

Example prompt:

> get_daily_movers로 최신 거래일 데이터를 가져와서 엑셀로 만들어줘.
> Sheet 1/2는 툴 결과 그대로 쓰고, 각 종목마다 웹 검색으로 "왜 올랐는지"를 상세하게 적어줘
> (재료/뉴스, 공시, 테마, 수급). Sheet 3에는 차트 URL을 넣어줘.

## Warnings

- **Keep the shared `?key=` URL private** while it still works. Anyone who has it can call the server without logging
  in, and their calls are logged as `shared_key`.
- **Free-plan pause.** Supabase pauses projects that are inactive for 7 days. The daily cron job keeps the project
  active. If it does pause, restore it from the dashboard; the data is kept.
- **Storage.** A year of history takes ~270 MB of the 500 MB free database, and nothing deletes old rows yet.
- **KRX key expires yearly.** When it does, `krx-ingest` fails with 401 and the days stay provisional (KIS data). Renew
  it at openapi.krx.co.kr, then backfill with `?from=…&to=…`.

## Docs

- [`docs/plan.md`](docs/plan.md): what to build next
- [`docs/log.md`](docs/log.md): what was done and why
- Usage: `select * from tool_usage_weekly order by week desc, calls desc;` (one row per tool call in `tool_calls`)
