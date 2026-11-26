# Working on this repo

## Commit
- Commit should be always made by user.

## Supabase CLI (v3)

- Migrations to production: `supabase db push --remote`. Plain `supabase db push` applies them to the local stack only.
- Queries on production: `supabase db query --remote --read-only "<sql>"`. A write needs `--remote --yes`, and only with the user's go-ahead.
- `supabase db reset` and `supabase functions serve` are local (tests).
- In agent mode, `supabase functions deploy` needs `--yes` to confirm; deploy only when the user asked for it.

## Checks before handing over

- `deno task check` (typecheck) and `deno task test` (unit).
- `deno task test:db` needs the local stack (`supabase start`, `supabase db reset` after a migration change).
- `deno task test:mcp` also needs `supabase functions serve mcp --env-file supabase/tests/functions.env`.

## Docs

- `docs/log.md`: what was done and why, oldest first; open items at the bottom (`## Open`). Keep it minimal: a few
  bullets per entry with the decision, the reason and the key numbers, not the investigation steps.
- `docs/requirements.md`, `docs/plan.md`, README (setup, useful SQL).
