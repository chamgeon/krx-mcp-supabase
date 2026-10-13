-- Copy to sql/cron.sql (git-ignored), replace <PROJECT_REF> and <INGEST_SECRET>, then run it once in the
-- Supabase dashboard → SQL Editor. It's not a migration because it contains your secret.
-- First enable the extensions: Database → Extensions → pg_cron and pg_net.
--
-- Each run fetches today (always re-fetched, so later runs overwrite earlier ones) plus any missing
-- weekdays from the last 7 days. Cron times are UTC (KST = UTC+9):
--   16:00–23:30 KST (07:00–14:30 UTC) Mon–Fri  every 30 min: picks up the day as soon as KRX publishes it
--   07:00–08:30 KST (22:00–23:30 UTC) daily    every 30 min: KRX often publishes only the next morning;
--                                              also catches any day the evening runs missed

select cron.schedule(
  'krx-ingest-evening',
  '0,30 7-14 * * 1-5',
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
  '0,30 22-23 * * *',
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
-- Remove:       select cron.unschedule('krx-ingest-evening');
--               select cron.unschedule('krx-ingest-morning');
