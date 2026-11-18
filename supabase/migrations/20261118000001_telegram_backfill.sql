-- Background backfill of a new Telegram channel (supabase/functions/_shared/telegram.ts). Adding a channel stores the
-- newest page and answers; the rest of the history (~30 days, at most 8 pages in all) is fetched after the response.
-- These columns hold that backfill's progress, so telegram-ingest can resume one whose worker ended, and the feed and
-- search tools can say a channel's older posts are still being collected.
--
--   backfill_before     next page: posts before this msg_id (the oldest one stored). null = no backfill pending
--   backfill_oldest_ts  time of that oldest stored post: a feed/search window starting earlier is incomplete
--   backfill_since      stop once posts reach this time (30 days before the channel was added)
--   backfill_pages      pages fetched so far, the first sync's included (failed pages count too, so retries end)
--   backfill_at         last progress; a pending backfill idle for 3+ minutes was interrupted and gets resumed
alter table public.telegram_channels
  add column if not exists backfill_before    int,
  add column if not exists backfill_oldest_ts timestamptz,
  add column if not exists backfill_since     timestamptz,
  add column if not exists backfill_pages     int not null default 0,
  add column if not exists backfill_at        timestamptz;

-- Pending backfills only (a handful at most): telegram-ingest's resume check and the feed/search notice
create index if not exists telegram_channels_backfill_idx
  on public.telegram_channels (username) where backfill_before is not null;

-- Adds `backfilling` (older posts still being collected) at the end; the other columns are unchanged.
create or replace view public.telegram_channel_stats
with (security_invoker = true) as
  select c.username, c.title, c.active, c.added_at, c.last_polled_at, c.last_error, c.poll_errors,
         count(m.msg_id)::int as posts, min(m.ts) as first_post, max(m.ts) as last_post,
         (c.backfill_before is not null) as backfilling
  from public.telegram_channels c
  left join public.telegram_messages m using (username)
  group by c.username;

notify pgrst, 'reload schema';
