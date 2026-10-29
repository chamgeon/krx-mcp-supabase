-- Copy to sql/cron.sql (git-ignored), replace <PROJECT_REF> and <INGEST_SECRET>, then run it once in the
-- Supabase dashboard → SQL Editor. It's not a migration because it contains your secret.
-- First enable the extensions: Database → Extensions → pg_cron and pg_net.
--
-- Cron times are UTC (KST = UTC+9):
--   kis-ingest  15:40, 16:00, 18:00 KST  (06:40, 07:00, 09:00 UTC)  Mon–Fri
--               same-day provisional snapshot from KIS: 10 min after the 15:30 close, then again after
--               시간외 종가 (15:40–16:00) and 시간외 단일가 (16:00–18:00); each run overwrites the day,
--               and holidays are skipped.
--   krx-ingest  07:00–08:30 KST          (22:00–23:30 UTC)        daily, every 30 min
--               KRX official data, published the next morning; replaces the KIS rows. Also fetches any
--               weekday from the last 7 days that still has no KRX data.
--
-- Migrating from the KRX-only schedule? Remove the old jobs first:
--   select cron.unschedule('krx-ingest-close');
--   select cron.unschedule('krx-ingest-evening');

select cron.schedule(
  'kis-ingest-close',
  '40 6 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/kis-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

select cron.schedule(
  'kis-ingest-after-hours',
  '0 7,9 * * 1-5',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/kis-ingest',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ingest-secret', '<INGEST_SECRET>'),
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
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ingest-secret', '<INGEST_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

-- Check runs:   select * from cron.job_run_details order by start_time desc limit 10;
-- HTTP results: select * from net._http_response order by created desc limit 10;
-- Remove:       select cron.unschedule('kis-ingest-close');
--               select cron.unschedule('kis-ingest-after-hours');
--               select cron.unschedule('krx-ingest-morning');
