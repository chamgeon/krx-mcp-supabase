-- Telegram gate (docs/plan.md → Phase 2; prompt and checks in supabase/functions/_shared/gate.ts). telegram-ingest
-- sends each new post to Claude Haiku, which labels it market or noise, names the companies it mentions and the events
-- it's about. The results go into columns of telegram_messages (no separate tags table):
--   label         'market' | 'noise'; null = not gated yet (shown, untagged)
--   stock_codes   KR codes the gate checked (empty until a post is gated: the name matcher that filled it before
--                 now lives only in the experiment, scripts/name_matcher.ts)
--   us_tickers    US tickers that passed the name check against us_symbols
--   events        ids from telegram_events
--   gate_version  prompt version (gate.ts GATE_VERSION), gated_at: when
-- Posts with gated_at null are gated by telegram-ingest, newest first, a batch per run: new posts, edited posts (the
-- trigger below), and every post stored before this migration (the backfill). To re-gate, set gated_at to null.

alter table public.telegram_messages
  add column if not exists label        text check (label in ('market', 'noise')),
  add column if not exists us_tickers   text[] not null default '{}',
  add column if not exists events       text[] not null default '{}',
  add column if not exists gate_version text,
  add column if not exists gated_at     timestamptz;

create index if not exists telegram_messages_ungated_idx on public.telegram_messages (ts desc) where gated_at is null;
create index if not exists telegram_messages_us_idx on public.telegram_messages using gin (us_tickers);
create index if not exists telegram_messages_events_idx on public.telegram_messages using gin (events);

-- An edited post (new text) is gated again. Posts are stored untagged (storePosts never writes the gate's columns), so
-- a page fetched again keeps its tags.
create or replace function public.telegram_messages_gate_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.text is distinct from old.text then
    new.gated_at := null;
  end if;
  return new;
end
$$;

drop trigger if exists telegram_messages_gate_guard on public.telegram_messages;
create trigger telegram_messages_gate_guard
  before update on public.telegram_messages
  for each row execute function public.telegram_messages_gate_guard();

-- US-listed stocks (Nasdaq, NYSE and the other US exchanges; no ETFs or test issues), from Nasdaq Trader's symbol
-- directory, refreshed daily by telegram-ingest. The gate checks US tickers against it; find_us_stock searches it.
create table if not exists public.us_symbols (
  ticker      text primary key,
  name        text not null,
  exchange    text not null,
  updated_at  timestamptz not null default now()
);
alter table public.us_symbols enable row level security; -- no policies: service role only
create index if not exists us_symbols_name_trgm_idx on public.us_symbols using gin (name extensions.gin_trgm_ops);

-- Events the gate tags posts with, chosen by hand (e.g. a company's IPO). Adding an event, or changing what it covers,
-- re-gates the posts from active_from (or the last 7 days), so earlier posts about it get tagged too. An event is used
-- while active_to is null or in the future.
create table if not exists public.telegram_events (
  id           text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  description  text not null,
  active_from  timestamptz,
  active_to    timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
alter table public.telegram_events enable row level security; -- no policies: service role only

create or replace function public.telegram_events_regate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.telegram_messages set gated_at = null
  where gated_at is not null and ts >= coalesce(new.active_from, now() - interval '7 days');
  return null;
end
$$;

drop trigger if exists telegram_events_regate on public.telegram_events;
create trigger telegram_events_regate
  after insert or update of description, active_from on public.telegram_events
  for each row execute function public.telegram_events_regate();

-- telegram_feed v2: hides noise (p_include_noise shows it), filters by US ticker or event, and returns the new
-- columns. Otherwise as 20261118000003_telegram_feed.sql. The return type changes, so the function is replaced.
drop function if exists public.telegram_feed(timestamptz, int, text[], text, boolean);

create or replace function public.telegram_feed(
  p_since         timestamptz,
  p_limit         int,
  p_channels      text[]  default null,  -- null: every channel
  p_stock         text    default null,  -- 종목코드: only posts tagged with it
  p_today_first   boolean default false,
  p_us            text    default null,  -- US ticker: only posts tagged with it
  p_event         text    default null,  -- event id: only posts tagged with it
  p_include_noise boolean default false
)
returns table (
  username       text,
  msg_id         int,
  ts             timestamptz,
  text           text,
  views          int,
  forwarded_from text,
  has_media      boolean,
  links          text[],
  stock_codes    text[],
  us_tickers     text[],
  events         text[],
  label          text,
  is_today       boolean,
  in_window      int,
  today          int
)
language sql
stable
set search_path = public
as $$
  with bounds as (
    select (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') as today_start
  ),
  base as (
    select m.username, m.msg_id, m.ts, m.text, m.views, m.forwarded_from, m.has_media, m.links, m.stock_codes,
           m.us_tickers, m.events, m.label, m.ts >= b.today_start as is_today
    from public.telegram_messages m, bounds b
    where m.ts >= p_since
      and (p_channels is null or m.username = any (p_channels))
      and (p_stock is null or m.stock_codes @> array[p_stock])
      and (p_us is null or m.us_tickers @> array[p_us])
      and (p_event is null or m.events @> array[p_event])
      and (p_include_noise or m.label is distinct from 'noise')
  ),
  ranked as (
    select base.*,
           (p_today_first and base.is_today) as first_tier,
           count(*) over (partition by base.username) as in_window,
           count(*) filter (where base.is_today) over (partition by base.username) as today
    from base
  ),
  numbered as (
    select ranked.*,
           row_number() over (partition by ranked.username, ranked.first_tier order by ranked.ts desc, ranked.msg_id desc) as rn
    from ranked
  ),
  picked as (
    select * from numbered
    order by first_tier desc, rn, ts desc, username
    limit p_limit
  )
  select username, msg_id, ts, text, views, forwarded_from, has_media, links, stock_codes, us_tickers, events, label,
         is_today, in_window::int, today::int
  from picked
  order by ts desc, username, msg_id desc;
$$;

revoke execute on function public.telegram_feed from public, anon, authenticated;
grant execute on function public.telegram_feed to service_role;

notify pgrst, 'reload schema';
