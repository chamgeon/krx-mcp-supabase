-- A run that hits the Edge Function time limit (150 s on the free plan) is stopped before it can record itself: on
-- 2026-11-18 two kis-ingest runs (11:55, 12:00 KST) left no row and sent no alert. So monitored() (functions/_shared/
-- ops.ts) now writes the row when a run starts and completes it at the end:
--   ok = null    running (summary may hold { progress: … } saved by the run)
--   ok = false   failed; a row still running 180 s after it started was stopped, and the next monitored run of any
--                job marks it failed (error starts with 'stopped before it finished') and alerts
--   ok = true    succeeded
-- ms and status stay null for a stopped run.
alter table public.ingest_runs alter column ok drop not null;

-- The sweep for stopped runs reads only running rows
create index if not exists ingest_runs_running_idx on public.ingest_runs (started_at) where ok is null;
