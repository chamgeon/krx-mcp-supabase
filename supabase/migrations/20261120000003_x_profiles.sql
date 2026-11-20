-- X account profiles: the bio, follower count and verified flag that come with every post the actor returns
-- (../functions/_shared/x.ts, saveAuthors), kept current on every backfill and poll and shown by list_x_accounts,
-- get_my_x_accounts and add_x_account. Stored rather than looked up by the model: X profile pages mostly show
-- fetchers a login wall, and the data comes free with the posts.

alter table public.x_accounts
  add column if not exists description  text,
  add column if not exists followers    bigint,
  add column if not exists verified     boolean;

notify pgrst, 'reload schema';
