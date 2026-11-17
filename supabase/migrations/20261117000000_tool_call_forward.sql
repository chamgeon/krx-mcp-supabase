-- Region forwarding, per tool call (supabase/functions/mcp/forward.ts). A request that lands outside DB_REGION is
-- forwarded once to the copy next to the database, which runs the tool and writes this row.
--   landed_in   region the request first landed in (near the caller); null = not forwarded
--   forward_ms  landing copy → this copy, one way, ms (difference of two hosts' clocks; the way back is similar)
--   handled_in  region the tool ran in (SB_REGION); null locally. A forward that failed is handled where it landed,
--               so it shows as handled_in outside DB_REGION with landed_in null.
-- Null for calls logged before these columns existed.
--
-- Hop by landing region:
--   select landed_in, count(*), percentile_cont(0.5) within group (order by forward_ms) as p50_ms,
--          percentile_cont(0.95) within group (order by forward_ms) as p95_ms
--   from tool_calls where forward_ms is not null group by 1 order by 2 desc;
alter table public.tool_calls
  add column if not exists landed_in  text,
  add column if not exists forward_ms int,
  add column if not exists handled_in text;
