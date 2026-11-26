-- telegram_chunks: a long Telegram post (over 1,500 characters: digests, market wraps) split into chunks of one item
-- each, with each chunk's own tags, so a filtered feed shows only the parts about a stock or an event. Written by
-- telegram-ingest's gate step (_shared/chunk.ts splits, the gate tags), replaced whenever the post is gated again
-- (an edit resets gated_at), and deleted with the post. No offsets and no copied context: where a chunk came from is
-- its post's channel, time and link.

create table if not exists public.telegram_chunks (
  username     text not null,
  msg_id       int  not null,
  idx          int  not null,                      -- order in the post, from 0
  text         text not null,
  stock_codes  text[] not null default '{}',       -- checked KRX codes named in this chunk
  us_tickers   text[] not null default '{}',
  events       text[] not null default '{}',       -- telegram_events ids this chunk is about
  primary key (username, msg_id, idx),
  foreign key (username, msg_id) references public.telegram_messages (username, msg_id) on delete cascade
);

alter table public.telegram_chunks enable row level security;

-- The long posts stored so far are gated again (prompt v6), which chunks them: ~240 posts, ~6 runs of 40
update public.telegram_messages set gated_at = null where char_length(text) > 1500;
