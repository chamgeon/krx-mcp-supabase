-- get_telegram_feed's selection (supabase/functions/mcp/telegram.ts). The newest N posts across channels were
-- dominated by one busy channel: on 2026-11-18 the default feed was 20 of 20 from insidertracking (114 posts a day
-- against 1–5 for the others). Slots are now shared round-robin: each channel's posts are numbered newest first, and
-- the N with the lowest numbers are taken, so every channel gets an equal share and a quiet channel's unused share
-- goes to the busy ones. With p_today_first (the default 3-day window), today's posts (KST) are shared out first and
-- earlier days only fill the slots left, so early in the morning or on a weekend the feed is still full.
--
-- Returns the picked posts newest first, each with its channel's counts in the window (in_window, today), so the
-- caller can say what was left out. One query; PostgREST can't express the window functions.
create or replace function public.telegram_feed(
  p_since       timestamptz,
  p_limit       int,
  p_channels    text[]  default null,  -- null: every channel
  p_stock       text    default null,  -- 종목코드: only posts tagged with it
  p_today_first boolean default false
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
           m.ts >= b.today_start as is_today
    from public.telegram_messages m, bounds b
    where m.ts >= p_since
      and (p_channels is null or m.username = any (p_channels))
      and (p_stock is null or m.stock_codes @> array[p_stock])
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
  select username, msg_id, ts, text, views, forwarded_from, has_media, links, stock_codes, is_today,
         in_window::int, today::int
  from picked
  order by ts desc, username, msg_id desc;
$$;

revoke execute on function public.telegram_feed from public, anon, authenticated;
grant execute on function public.telegram_feed to service_role;

notify pgrst, 'reload schema';
