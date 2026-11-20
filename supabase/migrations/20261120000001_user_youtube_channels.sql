-- Per-user YouTube preferences, like user_channels for Telegram: which collected channels a user follows (the default
-- scope of list_youtube_videos). Collection stays shared (youtube_channels). Keyed by the Supabase Auth user, so the
-- same Google account sees the same list from ChatGPT and Claude.

alter table public.youtube_channels
  add column if not exists added_by uuid references auth.users (id) on delete set null;

create table if not exists public.user_youtube_channels (
  user_id     uuid not null references auth.users (id) on delete cascade,
  channel_id  text not null references public.youtube_channels (channel_id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (user_id, channel_id)
);

create index if not exists user_youtube_channels_channel_idx on public.user_youtube_channels (channel_id);

-- RLS on with no policies: only the service role (used by the Edge Functions) can read/write.
alter table public.user_youtube_channels enable row level security;

-- Transcript search (list_youtube_videos query): trigram index for ilike '%…%', as for Telegram posts
create index if not exists youtube_videos_transcript_trgm_idx
  on public.youtube_videos using gin (transcript extensions.gin_trgm_ops);

notify pgrst, 'reload schema';
