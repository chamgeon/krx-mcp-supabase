-- One row per MCP tool call, for usage analysis (which tools, how often, by whom, how fast, which errors).
-- MCP never sends the user's prompt to the server, so only the tool arguments are recorded.
create table if not exists public.tool_calls (
  id              bigint generated always as identity primary key,
  ts              timestamptz not null default now(),
  user_id         uuid,          -- auth.users id once OAuth login is live; null for the shared ?key= URL
  auth            text not null, -- 'oauth' | 'shared_key'
  client          text,          -- User-Agent of the MCP client (ChatGPT, Claude, Inspector, ...)
  tool            text not null,
  args            jsonb,
  ok              boolean not null,
  error           text,
  latency_ms      int,
  response_bytes  int
);

create index if not exists tool_calls_ts_idx on public.tool_calls (ts desc);
create index if not exists tool_calls_user_ts_idx on public.tool_calls (user_id, ts desc);

-- RLS on with no policies: only the service role (used by the Edge Functions) can read/write.
alter table public.tool_calls enable row level security;

-- Weekly usage report: select * from public.tool_usage_weekly order by week desc, calls desc;
create or replace view public.tool_usage_weekly
with (security_invoker = true) as
  select date_trunc('week', ts at time zone 'Asia/Seoul')::date as week,
         tool,
         count(*)::int                                   as calls,
         count(distinct user_id)::int                    as users,
         count(*) filter (where user_id is null)::int    as shared_key_calls,
         count(*) filter (where not ok)::int             as errors,
         percentile_cont(0.5) within group (order by latency_ms)::int as p50_ms,
         percentile_cont(0.95) within group (order by latency_ms)::int as p95_ms
  from public.tool_calls
  group by 1, 2;
