-- Copy to sql/cron.sql (git-ignored), replace <PROJECT_REF> and <INGEST_SECRET>, then run it once in the
-- Supabase dashboard → SQL Editor. It's not a migration because it contains your secret.
-- First enable the extensions: Database → Extensions → pg_cron and pg_net.
--
-- Cron times are UTC (KST = UTC+9):
--   kis-ingest  09:05–15:20 KST, every 5 min                       Mon–Fri
--               intraday snapshot. The cron fires 09:00–15:55 KST and the time check inside skips runs
--               outside 09:05–15:20 (the opening auction and the 15:20–15:30 closing auction).
--   kis-ingest  15:40 KST               (06:40 UTC)              Mon–Fri
--               the day's 종가, 10 min after the 15:30 close (시간외 종가 trades at the close).
--   kis-ingest  17:05, 18:05, 19:05, 20:05 KST  (08:05–11:05 UTC)  Mon–Fri
--               the 16:00–20:00 after-market (continuous trading since 2026-09-14, replacing 시간외 단일가):
--               the after-market price becomes the live close; 20:05 takes its last price. Each run overwrites
--               the day, and holidays are skipped.
--   krx-ingest  07:00–08:30 KST          (22:00–23:30 UTC)        daily, every 30 min
--               KRX official data, published the next morning, into daily_prices; the prices view shows it in
--               place of the day's KIS rows. Also fetches any weekday from the last 7 days that still has no
--               KRX data.
--   telegram-ingest  every 5 min, daily
--               new posts from every collected public Telegram channel (one request per channel).
--   youtube-ingest  every 5 min (2 min after telegram-ingest), daily
--               new uploads from every collected YouTube channel (its RSS feed), then the transcripts that are
--               due (Apify; needs the APIFY_API_KEY secret).
--   x-ingest  every 5 min (4 min after telegram-ingest), daily
--               new posts from every collected X account, one Apify run for all of them (needs APIFY_API_KEY).
--   market-ingest  ?set=live  every 5 min (1 min after kis-ingest), 09:01–01:56 KST  (00–16 UTC)  Mon–Fri
--               KRW/USD (the Seoul FX session runs 09:00–02:00 KST), plus KOSPI / KOSDAQ during 09:00–15:40 KST,
--               into market_quotes (one row per symbol, overwritten).
--   market-ingest  ?set=bonds  18:30 KST  (09:30 UTC)  Mon–Fri
--               국고채 1/3/5/10/20/30년 yields, the day's final value.
--   market-ingest  ?set=us  every 5 min (3 min after kis-ingest), 22:03–06:58 KST  (13–21 UTC)  Mon–Fri
--               Yahoo Finance: US indices and Treasury yields (market_quotes), and the US tickers mentioned in posts
--               in the last 90 days plus fixed ETFs (us_quotes). Covers the US session in both winter (23:30–06:00 KST)
--               and summer time (22:30–05:00 KST); off-session runs just rewrite the last close.
--   pipeline-report  18:00 KST          (09:00 UTC)              daily
--               Telegram report of the last 24 h of ingest runs (needs the TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
--               secrets). Already set up? Add only this job.
--
-- Migrating from the KRX-only schedule? Remove the old jobs first:
--   select cron.unschedule('krx-ingest-close');
--   select cron.unschedule('krx-ingest-evening');

select cron.schedule(
  'kis-ingest-intraday',
  '*/5 0-6 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/kis-ingest',
    -- x-region: run in Seoul, next to the KIS API (93 calls a run), not next to the database (a few calls)
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-region', 'ap-northeast-2', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  )
  where (now() at time zone 'Asia/Seoul')::time >= '09:05' and (now() at time zone 'Asia/Seoul')::time < '15:21';
  $$
);

select cron.schedule(
  'kis-ingest-close',
  '40 6 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/kis-ingest',
    -- x-region: run in Seoul, next to the KIS API (93 calls a run), not next to the database (a few calls)
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-region', 'ap-northeast-2', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

select cron.schedule(
  'kis-ingest-after-hours',
  '5 8-11 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/kis-ingest',
    -- x-region: run in Seoul, next to the KIS API (93 calls a run), not next to the database (a few calls)
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-region', 'ap-northeast-2', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

select cron.schedule(
  'krx-ingest-morning',
  '0,30 22-23 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/krx-ingest',
    -- x-region: run in Seoul, next to the KRX API (two large answers per day), not next to the database
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-region', 'ap-northeast-2', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

select cron.schedule(
  'telegram-ingest',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/telegram-ingest',
    -- x-region: fetch t.me from Seoul; Telegram hides some channels' previews from Mumbai (log 2026-11-20)
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-region', 'ap-northeast-2', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

select cron.schedule(
  'pipeline-report',
  '0 9 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/pipeline-report',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'youtube-ingest',
  '2-57/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/youtube-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

select cron.schedule(
  'x-ingest',
  '4-59/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/x-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

select cron.schedule(
  'market-ingest-live',
  '1-59/5 0-16 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/market-ingest?set=live',
    -- x-region: run in Seoul, next to the KIS API
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-region', 'ap-northeast-2', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'market-ingest-bonds',
  '30 9 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/market-ingest?set=bonds',
    -- x-region: run in Seoul, next to the KIS API
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-region', 'ap-northeast-2', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'market-ingest-us',
  '3-58/5 13-21 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/market-ingest?set=us',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-region', 'ap-northeast-2', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Ingest runs:  select * from ingest_runs order by started_at desc limit 20;
-- Check runs:   select * from cron.job_run_details order by start_time desc limit 10;
-- HTTP results: select * from net._http_response order by created desc limit 10;
-- Remove:       select cron.unschedule('kis-ingest-intraday');
--               select cron.unschedule('kis-ingest-close');
--               select cron.unschedule('kis-ingest-after-hours');
--               select cron.unschedule('krx-ingest-morning');
--               select cron.unschedule('telegram-ingest');
--               select cron.unschedule('youtube-ingest');
--               select cron.unschedule('x-ingest');
--               select cron.unschedule('pipeline-report');
--               select cron.unschedule('market-ingest-live');
--               select cron.unschedule('market-ingest-bonds');
--               select cron.unschedule('market-ingest-us');
