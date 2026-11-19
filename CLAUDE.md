# Working on this repo

## Supabase CLI (v3): local by default

- **Migrations to production: `supabase db push --remote`.** Plain `supabase db push` applies them to the local stack
  only. Deploy order: `supabase db push --remote` first, then `supabase functions deploy …`; a function deployed
  before its migration fails on the missing columns (2026-11-19: telegram-ingest, "column … gated_at does not exist").
- Queries on production: `supabase db query --remote --read-only "<sql>"`. A write needs `--remote --yes`, and only
  with the user's go-ahead.
- `supabase db reset` and `supabase functions serve` are local (tests).
- In agent mode, `supabase functions deploy` needs `--yes` to confirm; deploy only when the user asked for it.

## Checks before handing over

- `deno task check` (typecheck) and `deno task test` (unit).
- `deno task test:db` needs the local stack (`supabase start`, `supabase db reset` after a migration change).
- `deno task test:mcp` also needs `supabase functions serve mcp --env-file supabase/tests/functions.env`.

## Docs

- `docs/log.md`: what was done and why, oldest first; open items at the bottom (`## Open`).
- `docs/requirements.md`, `docs/plan.md`, README (setup, useful SQL).
