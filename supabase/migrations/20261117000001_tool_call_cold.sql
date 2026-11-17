-- Cold or warm, per tool call, for both function instances a forwarded call goes through (forward.ts):
--   landing_cold / landing_idle_ms   the instance the request landed on (near the caller); null = not forwarded
--   handled_cold / handled_idle_ms   the instance that ran the tool (next to the database)
-- cold = the instance's first request (just started); idle_ms = ms since its previous request (null when cold).
-- An instance's first request is often the MCP handshake (initialize), not the tool call, so a tool call right after
-- it is warm with a small idle_ms. Null for calls logged before these columns existed.
--
-- Hop, warm landing vs. cold landing:
--   select landed_in, landing_cold, handled_cold, count(*),
--          percentile_cont(0.5) within group (order by forward_ms) as p50_forward_ms
--   from tool_calls where forward_ms is not null group by 1, 2, 3 order by 1, 2, 3;
alter table public.tool_calls
  add column if not exists landing_cold    boolean,
  add column if not exists landing_idle_ms int,
  add column if not exists handled_cold    boolean,
  add column if not exists handled_idle_ms int;
