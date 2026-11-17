-- From region forwarding (11-16 16:18) until the fix in mcp/forward.ts (CLIENT_HEADER), the handling copy logged the
-- forwarded request's User-Agent, to which the runtime appends its own:
--   "Claude-User (variant; SupabaseEdgeRuntime/1.79.1; ref=<project ref>)"
-- so the same client showed up under two names, with the project ref in every row. Restores the caller's value.
update public.tool_calls
set client = regexp_replace(client, ' \(variant; SupabaseEdgeRuntime/[^)]*\)$', '')
where client like '% (variant; SupabaseEdgeRuntime/%';
