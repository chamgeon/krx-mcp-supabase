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
| `list_available_dates()` | Trading days loaded in the database |

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

### Implementation notes

- **Untraded days.** KRX reports a stock that didn't trade (a trading halt, or simply no trades) with open/high/low = 0
  and the previous close carried forward. Those zeros are treated as missing values, and a stock without trades on the
  analysis date is never a breakout. Screens leave such stocks out unless `include_untraded` is set.
- **Performance.** PostgREST cancels queries after 8 s, and the free-plan database is small. The screener reads a
  covering index on `(bas_dd, isu_cd)` through a materialized CTE, so it's one sequential range read instead of
  ~360k random heap fetches. Per-stock window functions only run over the short window (~21 trading days). The
  60/120-day highs come from a plain grouped `max`, computed only when a 60/120-day breakout is requested.
  A full-market screen takes about 0.2–0.5 s.
- **History.** Windows count trading days, so 120-day metrics need about 6 months of loaded data. Anything without
  enough history comes back `null`.

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

### 7. Connect a chatbot

The MCP endpoint (Streamable HTTP) is:

```
https://<PROJECT_REF>.supabase.co/functions/v1/mcp?key=<MCP_ACCESS_KEY>
```

- **ChatGPT**: Settings → Apps & Connectors → Advanced → enable Developer mode, then create a connector with the URL.
- **Claude**: Settings → Connectors → Add custom connector.
- **Testing**: `npx -y @modelcontextprotocol/inspector`

After a tool's parameters change, refresh the connector so the client sees the new schema.

Example prompt:

> get_daily_movers로 최신 거래일 데이터를 가져와서 엑셀로 만들어줘.
> Sheet 1/2는 툴 결과 그대로 쓰고, 각 종목마다 웹 검색으로 "왜 올랐는지"를 상세하게 적어줘
> (재료/뉴스, 공시, 테마, 수급). Sheet 3에는 차트 URL을 넣어줘.

## Notes

- **Provisional vs. official**: `daily_prices.source` is `kis` for same-day rows and `krx` once KRX's data replaces
  them (`available_dates.final`). The MCP tools return `data_status` (장중 / 잠정치 / 확정치) so the client knows. KIS has no
  whole-market endpoint, so kis-ingest takes the stock list from the latest stored day and carries forward what KIS
  doesn't return (market, 소속부, 상장주식수); 시가총액 = 종가 × 상장주식수. A stock listed that day is missing until
  KRX's data arrives, and 거래량/거래대금 may rise slightly when it does.
- **Intraday data**: each snapshot overwrites the day's rows, so intraday history isn't kept and storage doesn't grow.
  `as_of` records when the snapshot was taken. Mid-session, today's 거래량/거래대금 are partial, so the tools return
  `session_elapsed` and a warning that spike ratios against full-day averages are understated. `analyze_stock` adds a
  live quote (one KIS call) while the market is open.
- **KIS token**: the OAuth access token (valid 24 h) is cached in `public.kis_token` and reused across runs, since KIS
  limits how often a token can be issued.
- **Security**: the `?key=` in the URL is the only protection on the MCP endpoint, so keep the URL private. The table
  has RLS enabled with no policies, and only the service role (used by the Edge Functions) can read it or run
  `screen_stocks`.
- **Charts**: chart URLs point to Naver Finance images (unofficial). They always show the current chart, not the chart
  as of the requested date.
- **Storage** ⚠️: ~2,700 rows per trading day come to ~1 MB including indexes, so a year of history takes ~265 MB
  and the 500 MB free database fills up in under two years (as of 2026-10-29: 276 MB used, ~10 months left).
  Nothing deletes old rows yet. Options: a retention job that drops rows older than ~14 months (enough for the
  120-day metrics and `analyze_stock`'s 250-row window), and dropping `daily_prices_date_rate_idx` (31 MB, rarely
  used).
- **Free-plan pause**: projects inactive for 7 days are paused. The daily cron keeps it active; if it does pause,
  restore it from the dashboard and the data is kept.
- **Report thresholds** (`SHEET1_MIN_RATE` etc.) are constants at the top of `supabase/functions/mcp/index.ts`.
