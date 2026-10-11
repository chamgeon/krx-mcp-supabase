# KR stock movers — MCP server on Supabase (free plan)

Every trading day after the close, a scheduled job pulls that day's KOSPI + KOSDAQ data from the KRX Open API into Postgres.
An MCP server (a Supabase Edge Function) hands ChatGPT / Claude the report already split into sheets:

| Tool | What it returns |
|---|---|
| `get_daily_movers(date?)` | **sheet1**: 등락률 ≥ +15% · **sheet2**: 등락률 ≥ +7% and 거래대금 ≥ 500억, sheet1 제외 · both sorted by 등락률 desc · **sheet3_charts**: 일봉/주봉/월봉 URLs |
| `get_stock_history(code, days)` | Recent daily rows for one stock (helps explain *why* it moved) |
| `find_stock(name)` | Name → 종목코드 |
| `list_available_dates()` | Which days are loaded |
| `screen_stocks(date?, filters…)` | All stocks matching optional filters — 등락률/거래대금/거래량/시총, 거래대금·거래량 vs N-day avg, 거래대금 연속 증가, 박스권 + 거래대금 증가, 20/60/120-day breakouts, 연속 상승, volatility — with every metric per row. Runs as the SQL function `public.screen_stocks` |
| `analyze_stock(stock, date?)` | One stock: 1/5/10/20/60/120-day returns, 거래대금 ratios and spikes, MA5/20/60/120 (정배열, 5/20 cross), breakouts, volatility/ATR, up/down streaks, box and price-vs-거래대금 divergence, plus a `signals` list |

The screening and analysis tools are pure SQL/TypeScript math on stored data (no LLM). Windows count trading days, so
120-day metrics need ~121 loaded days (backfill ~6 months); anything without enough history comes back `null`.

The LLM does the rest: web search for the reason each stock rose, and building the Excel file.

```
KRX Open API ──(16:10 / 18:40 KST, pg_cron)──> krx-ingest ──> Postgres ──> mcp ──> ChatGPT / Claude
```

## Step 1 — KRX API key (best: in her name)

1. Sign up at https://openapi.krx.co.kr and apply for an API 인증키.
2. Apply separately for each service (서비스 이용신청). You need two:
   - 주식 → **유가증권 일별매매정보** (`stk_bydd_trd`)
   - 주식 → **코스닥 일별매매정보** (`ksq_bydd_trd`)
3. Wait for approval (usually same day).

KRX's terms forbid giving the data to third parties, so the cleanest setup is that she registers the key herself.

## Step 2 — Supabase project

1. Create a free project at https://supabase.com. Note the **project ref** (the `xxxx` in `https://xxxx.supabase.co`). Seoul region is a good choice.
2. Install the Supabase CLI (2.117+) and Deno, then from this folder:

```bash
supabase login
supabase link --project-ref <PROJECT_REF>
supabase db push            # creates the daily_prices table
supabase config push        # applies verify_jwt = false for both functions
```

## Step 3 — Secrets

Make up two long random strings (e.g. `openssl rand -hex 24`), one for the ingest job, one for the MCP URL.

```bash
supabase secrets set \
  KRX_API_KEY=<her KRX key> \
  INGEST_SECRET=<random string 1> \
  MCP_ACCESS_KEY=<random string 2>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions automatically.

## Step 4 — Deploy the functions

```bash
supabase functions deploy krx-ingest
supabase functions deploy mcp
```

## Step 5 — Load data

Load the last week (and test the KRX key):

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/krx-ingest" \
  -H "x-ingest-secret: <INGEST_SECRET>"
```

The response lists each date with a row count (~2,700 rows for a normal trading day), `0` for holidays,
or an error message (e.g. a KRX service you haven't been approved for yet).

Optional backfill (2 KRX calls per weekday; the limit is 10,000/day):

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/krx-ingest?from=20260101&to=20261010" \
  -H "x-ingest-secret: <INGEST_SECRET>"
```

If a long range times out, split it into ~1-month chunks.

## Step 6 — Schedule it

Dashboard → Database → Extensions: enable **pg_cron** and **pg_net**.
Then open `sql/cron.sql`, fill in `<PROJECT_REF>` and `<INGEST_SECRET>`, and run it in the SQL Editor.
It runs at 15:40 and 16:10 KST (first load after the close) and 18:40 KST (final numbers after after-hours trading)
on weekdays, plus a daily 08:20 KST safety run that fills in any day the evening runs missed.

## Step 7 — Test the MCP server

```bash
npx -y @modelcontextprotocol/inspector
```

Transport: Streamable HTTP, URL:

```
https://<PROJECT_REF>.supabase.co/functions/v1/mcp?key=<MCP_ACCESS_KEY>
```

Call `get_daily_movers` with no arguments.

## Step 8 — Connect her chatbot

Use the same URL (with `?key=...`), no authentication:

- **ChatGPT**: Settings → Apps & Connectors → Advanced → enable Developer mode, then create a connector with the URL.
- **Claude**: Settings → Connectors → Add custom connector.

Suggested prompt for her:

> get_daily_movers로 최신 거래일 데이터를 가져와서 엑셀로 만들어줘.
> Sheet 1/2는 툴 결과 그대로 쓰고, 각 종목마다 웹 검색으로 "왜 올랐는지"를 나중에 봐도 이해될 만큼 상세하게 적어줘
> (재료/뉴스, 공시, 테마, 수급). Sheet 3에는 차트 URL을 넣어줘.

## Notes

- **Timing**: today's data is loaded at 15:40 KST (or 16:10 if KRX isn't ready yet) and overwritten with final numbers at 18:40 KST.
  If KRX hasn't published yet, a run simply stores nothing and the next run picks it up.
  First week: check `list_available_dates` in the evening to confirm KRX really has same-day data by then.
- **Chart URLs** are Naver Finance images (unofficial). They always show the *current* chart, not the chart as of that date.
- **Storage**: ~2,700 rows/day ≈ well under 1 MB/day, so the 500 MB free database lasts years.
- **Free-plan pause**: projects with no activity for 7 days get paused. Daily cron + her usage should keep it active; if it pauses, restore it in the dashboard (data is kept).
- **Security**: the `?key=` in the URL is the only protection — don't share the URL.
- Thresholds are constants at the top of `supabase/functions/mcp/index.ts` (`SHEET1_MIN_RATE`, etc.).
