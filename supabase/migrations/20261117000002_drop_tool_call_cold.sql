-- Drops the cold/idle columns added in 20261117000001. They described the function instances, not what the user
-- waits for: an instance's first request is usually the MCP handshake (not logged), so tool calls showed as warm
-- while their first queries still paid connection setup. forward_ms / landed_in / handled_in stay.
alter table public.tool_calls
  drop column if exists landing_cold,
  drop column if exists landing_idle_ms,
  drop column if exists handled_cold,
  drop column if exists handled_idle_ms;
