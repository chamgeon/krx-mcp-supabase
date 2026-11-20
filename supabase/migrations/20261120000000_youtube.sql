-- YouTube channels and their videos' transcripts (supabase/functions/youtube-ingest). New uploads come from each
-- channel's public RSS feed (youtube.com/feeds/videos.xml?channel_id=…, the newest 15, no key needed); transcripts
-- from an Apify actor (apihq/youtube-transcript-scraper, ~$0.003 a transcript, nothing charged for a failure).
--
-- A channel's first poll stores only its newest videos (BACKFILL_VIDEOS); after that, every video newer than the
-- oldest one stored. A video waits for its transcript (transcript_status 'pending') and is retried with a growing
-- pause, since YouTube's captions can take a while after upload (and a live stream has none until it ends); a video
-- still without one well after it was published is 'none'. Shorts aren't stored.
--
-- Collection is shared, like Telegram's. Channels are added by hand (README → YouTube).

create table if not exists public.youtube_channels (
  channel_id      text primary key check (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  title           text,
  language        text not null default 'ko',     -- the transcript language asked for (ISO 639-1)
  added_at        timestamptz not null default now(),
  active          boolean not null default true,  -- polled by youtube-ingest
  last_polled_at  timestamptz,
  last_error      text,
  poll_errors     int not null default 0          -- consecutive failures
);

create table if not exists public.youtube_videos (
  video_id           text primary key check (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  channel_id         text not null references public.youtube_channels (channel_id) on delete cascade,
  title              text not null,
  description        text not null default '',
  published_at       timestamptz not null,
  duration_seconds   int,
  transcript         text,                        -- the segments joined, null until fetched
  segments           jsonb,                       -- [{start, duration, text}] as the actor returns them
  transcript_lang    text,
  transcript_auto    boolean,                     -- auto-generated captions (speech recognition: names can be off)
  transcript_status  text not null default 'pending'
                     check (transcript_status in ('pending', 'ok', 'none', 'failed')),
  attempts           int not null default 0,
  next_attempt_at    timestamptz not null default now(),
  last_error         text,
  fetched_at         timestamptz not null default now(),
  transcribed_at     timestamptz
);

create index if not exists youtube_videos_channel_idx on public.youtube_videos (channel_id, published_at desc);
create index if not exists youtube_videos_published_idx on public.youtube_videos (published_at desc);
create index if not exists youtube_videos_pending_idx on public.youtube_videos (next_attempt_at)
  where transcript_status = 'pending';

-- RLS on with no policies: only the service role (used by the Edge Functions) can read/write.
alter table public.youtube_channels enable row level security;
alter table public.youtube_videos enable row level security;

notify pgrst, 'reload schema';
