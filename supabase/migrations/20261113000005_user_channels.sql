-- Per-user preferences: which collected Telegram channels a user follows. Collection itself stays shared
-- (telegram_channels); this only decides what get_telegram_feed shows a user by default.
-- Keyed by the Supabase Auth user, so the same Google account sees the same list from ChatGPT and Claude.

create table if not exists public.user_channels (
  user_id   uuid not null references auth.users (id) on delete cascade,
  username  text not null references public.telegram_channels (username) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (user_id, username)
);

create index if not exists user_channels_username_idx on public.user_channels (username);

-- RLS on with no policies: only the service role (used by the Edge Functions) can read/write.
alter table public.user_channels enable row level security;

-- Whoever added a channel follows it.
insert into public.user_channels (user_id, username)
  select added_by, username from public.telegram_channels where added_by is not null
  on conflict do nothing;

notify pgrst, 'reload schema';
