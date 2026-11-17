-- One row per ingest run (krx-ingest, kis-ingest, telegram-ingest), written by each function itself
-- (supabase/functions/_shared/ops.ts). pg_cron only starts the HTTP request, so cron.job_run_details says
-- "succeeded" even when the function refuses a batch, and net._http_response keeps the answer only a few hours.
-- This table is the durable record: the 18:00 report (pipeline-report) reads it, and a failed run sends an immediate
-- Telegram alert (at most one per job per hour: `alerted`). Rows older than 90 days are deleted by the report.
create table if not exists public.ingest_runs (
  id          bigint generated always as identity primary key,
  job         text        not null,           -- 'krx-ingest' | 'kis-ingest' | 'telegram-ingest'
  started_at  timestamptz not null,
  ms          int,                            -- how long the run took
  ok          boolean     not null,           -- the function answered 2xx
  status      int,                            -- its HTTP status
  summary     jsonb,                          -- its JSON answer (Telegram: failed channels only)
  error       text,                           -- why it failed, from the answer
  alerted     boolean     not null default false  -- an immediate Telegram alert was sent for this run
);

create index if not exists ingest_runs_started_idx on public.ingest_runs (started_at desc);
create index if not exists ingest_runs_job_idx on public.ingest_runs (job, started_at desc);

-- RLS on with no policies: only the service role (the Edge Functions) can read/write.
alter table public.ingest_runs enable row level security;
