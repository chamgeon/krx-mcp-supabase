-- X (Twitter) accounts and their posts (supabase/functions/x-ingest, ../_shared/x.ts). Posts come from an Apify actor
-- (xquik/x-tweet-scraper, ~$0.15 per 1,000 posts plus ~$0.00008 a run): a new account's latest posts once, then one
-- run every 5 minutes for all accounts, asking only for posts since the last poll. Retweets are left out (in the
-- actor, so they aren't paid for); posts, quotes and the author's replies are kept.
--
-- Collection is shared, like Telegram's and YouTube's; user_x_accounts holds who follows what.

create table if not exists public.x_accounts (
  username        text primary key check (username ~ '^[a-z0-9_]{1,15}$'),  -- lowercase, without @
  x_user_id       text,
  name            text,
  added_by        uuid references auth.users (id) on delete set null,
  added_at        timestamptz not null default now(),
  active          boolean not null default true,  -- polled by x-ingest
  last_polled_at  timestamptz,                    -- null: not backfilled yet
  last_error      text,
  poll_errors     int not null default 0          -- consecutive failures
);

create table if not exists public.x_posts (
  id              text primary key check (id ~ '^\d{1,20}$'),   -- X's post id (a 64-bit number, kept as text)
  username        text not null references public.x_accounts (username) on delete cascade,
  ts              timestamptz not null,
  text            text not null default '',
  url             text not null,
  lang            text,
  is_reply        boolean not null default false,
  quoted_text     text,                           -- the post this one quotes, if any
  quoted_url      text,
  media           text[] not null default '{}',   -- image URLs (charts, often)
  links           text[] not null default '{}',   -- expanded links in the text
  views           bigint,
  likes           int,
  reposts         int,
  replies         int,
  fetched_at      timestamptz not null default now()
);

create index if not exists x_posts_ts_idx on public.x_posts (ts desc);
create index if not exists x_posts_user_ts_idx on public.x_posts (username, ts desc);
create index if not exists x_posts_text_trgm_idx on public.x_posts using gin (text extensions.gin_trgm_ops);

create table if not exists public.user_x_accounts (
  user_id     uuid not null references auth.users (id) on delete cascade,
  username    text not null references public.x_accounts (username) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (user_id, username)
);
create index if not exists user_x_accounts_username_idx on public.user_x_accounts (username);

-- RLS on with no policies: only the service role (used by the Edge Functions) can read/write.
alter table public.x_accounts enable row level security;
alter table public.x_posts enable row level security;
alter table public.user_x_accounts enable row level security;

notify pgrst, 'reload schema';
