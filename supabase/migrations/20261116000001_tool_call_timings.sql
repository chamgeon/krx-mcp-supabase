-- Per-step timings of a tool call: [{"step": "messages", "start": 12, "ms": 950}, ...] (start = ms after the tool began,
-- so overlapping parallel steps are visible). Written by the mcp function (supabase/functions/mcp/timing.ts). Null for
-- calls logged before this column existed, and for tools without instrumented steps.
--
-- Median of each step per tool:
--   select tool, s->>'step' as step, percentile_cont(0.5) within group (order by (s->>'ms')::int) as p50_ms, count(*)
--   from tool_calls, jsonb_array_elements(timings) as s group by 1, 2 order by 1, 3 desc;
alter table public.tool_calls add column if not exists timings jsonb;
