-- Run this once in the Supabase dashboard → SQL Editor (not as a migration: it contains your secret).
-- First enable the extensions: Database → Extensions → pg_cron and pg_net.
-- Replace <PROJECT_REF> and <INGEST_SECRET>.
--
-- Each run fetches today (always re-fetched, so later runs overwrite earlier ones) plus any missing
-- weekdays from the last 7 days. Cron times are UTC (KST = UTC+9):
--   15:40 KST (06:40 UTC) Mon–Fri  early try, 10 min after the 15:30 close (stores nothing if KRX isn't ready)
--   16:10 KST (07:10 UTC) Mon–Fri  first load, if 15:40 was too early
--   18:40 KST (09:40 UTC) Mon–Fri  final numbers, after the 16:00–18:00 after-hours session
--   08:20 KST (23:20 UTC) daily    safety net: catches any day the evening runs missed

select cron.schedule(
  'krx-ingest-early',
  '40 6 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/krx-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'krx-ingest-close',
  '10 7 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/krx-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'krx-ingest-final',
  '40 9 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/krx-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'krx-ingest-morning',
  '20 23 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/krx-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Check runs:   select * from cron.job_run_details order by start_time desc limit 10;
-- HTTP results: select * from net._http_response order by created desc limit 10;
-- Remove:       select cron.unschedule('krx-ingest-early');
--               select cron.unschedule('krx-ingest-close');
--               select cron.unschedule('krx-ingest-final');
--               select cron.unschedule('krx-ingest-morning');
