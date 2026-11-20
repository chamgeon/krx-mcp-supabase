-- The gate for X posts, as for Telegram posts (20261119000000_telegram_gate.sql): x-ingest sends each new post (with
-- the text it quotes) to Claude Haiku, which labels it market or noise and names the companies and events it's about.
-- Same columns, same meaning:
--   label         'market' | 'noise'; null = not gated yet (shown, untagged)
--   stock_codes   KR codes that passed the name check; us_tickers: US tickers that passed it against us_symbols
--   events        ids from telegram_events (the event list is shared with Telegram)
--   gate_version  prompt version (gate.ts GATE_VERSION), gated_at: when
-- Posts with gated_at null are gated by x-ingest, newest first, a batch per run: new posts, edited ones (the trigger
-- below), and those already stored (the backfill). Adding an event re-gates the X posts in its window too.

alter table public.x_posts
  add column if not exists label        text check (label in ('market', 'noise')),
  add column if not exists stock_codes  text[] not null default '{}',
  add column if not exists us_tickers   text[] not null default '{}',
  add column if not exists events       text[] not null default '{}',
  add column if not exists gate_version text,
  add column if not exists gated_at     timestamptz;

create index if not exists x_posts_ungated_idx on public.x_posts (ts desc) where gated_at is null;
create index if not exists x_posts_stock_idx on public.x_posts using gin (stock_codes);
create index if not exists x_posts_us_idx on public.x_posts using gin (us_tickers);
create index if not exists x_posts_events_idx on public.x_posts using gin (events);

-- A post whose text (or the text it quotes) changed is gated again. Polls upsert posts without the gate's columns, so
-- a post fetched again keeps its tags.
create or replace function public.x_posts_gate_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.text is distinct from old.text or new.quoted_text is distinct from old.quoted_text then
    new.gated_at := null;
  end if;
  return new;
end
$$;

drop trigger if exists x_posts_gate_guard on public.x_posts;
create trigger x_posts_gate_guard
  before update on public.x_posts
  for each row execute function public.x_posts_gate_guard();

-- A new event re-gates the posts in its window: Telegram's (as before) and now X's.
create or replace function public.telegram_events_regate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.telegram_messages set gated_at = null
  where gated_at is not null
    and ts >= new.active_from
    and (new.active_to is null or ts < new.active_to);
  update public.x_posts set gated_at = null
  where gated_at is not null
    and ts >= new.active_from
    and (new.active_to is null or ts < new.active_to);
  return null;
end
$$;

notify pgrst, 'reload schema';
