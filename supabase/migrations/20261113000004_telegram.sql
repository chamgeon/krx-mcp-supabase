-- Public Telegram channels, collected from the t.me/s/<channel> web preview (see supabase/functions/_shared/telegram.ts).
-- Collection is shared: a channel is collected once for everyone, however many users follow it. Per-user preferences
-- (which channels a user follows) come later as a separate table.

create extension if not exists pg_trgm with schema extensions;

create table if not exists public.telegram_channels (
  username        text primary key,               -- lowercase, without @
  title           text,
  added_by        uuid references auth.users (id) on delete set null,
  added_at        timestamptz not null default now(),
  active          boolean not null default true,  -- polled by telegram-ingest
  last_polled_at  timestamptz,
  last_msg_id     int,                            -- newest post we have
  last_error      text,
  poll_errors     int not null default 0          -- consecutive failures
);

create table if not exists public.telegram_messages (
  username        text not null references public.telegram_channels (username) on delete cascade,
  msg_id          int  not null,
  ts              timestamptz not null,
  text            text not null default '',
  views           int,
  forwarded_from  text,
  has_media       boolean not null default false,
  links           text[] not null default '{}',
  edited          boolean not null default false,
  stock_codes     text[] not null default '{}',   -- 종목코드 mentioned by name (3+ chars) or code
  fetched_at      timestamptz not null default now(),
  primary key (username, msg_id)
);

create index if not exists telegram_messages_ts_idx on public.telegram_messages (ts desc);
create index if not exists telegram_messages_stock_idx on public.telegram_messages using gin (stock_codes);
-- Korean search: trigram index for ilike '%…%' (Postgres full-text search doesn't tokenize Korean)
create index if not exists telegram_messages_text_trgm_idx
  on public.telegram_messages using gin (text extensions.gin_trgm_ops);

create or replace view public.telegram_channel_stats
with (security_invoker = true) as
  select c.username, c.title, c.active, c.added_at, c.last_polled_at, c.last_error, c.poll_errors,
         count(m.msg_id)::int as posts, min(m.ts) as first_post, max(m.ts) as last_post
  from public.telegram_channels c
  left join public.telegram_messages m using (username)
  group by c.username;

-- RLS on with no policies: only the service role (used by the Edge Functions) can read/write.
alter table public.telegram_channels enable row level security;
alter table public.telegram_messages enable row level security;

notify pgrst, 'reload schema';
