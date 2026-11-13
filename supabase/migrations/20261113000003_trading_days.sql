-- available_dates counted rows per day over all of daily_prices (742k rows, ~3 s on a cold cache), and every MCP tool
-- reads it to report whether the day is provisional or final. Now:
--   * trading_days: one row per KRX-loaded day with its row count, kept in sync by statement triggers on daily_prices
--     (covers krx-ingest, manual reruns and deletes).
--   * available_dates: trading_days (final) + the live_prices days KRX doesn't have yet (provisional). Same columns.

create table if not exists public.trading_days (
  bas_dd     date primary key,
  row_count  int  not null
);

-- RLS on with no policies: only the service role (used by the Edge Functions) can read/write.
alter table public.trading_days enable row level security;

insert into public.trading_days (bas_dd, row_count)
  select bas_dd, count(*)::int from public.daily_prices group by bas_dd
  on conflict (bas_dd) do update set row_count = excluded.row_count;

-- Recount only the days a statement touched (index-only count over ~2,800 rows per day).
create or replace function public.sync_trading_days()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into trading_days (bas_dd, row_count)
    select d.bas_dd, (select count(*) from daily_prices p where p.bas_dd = d.bas_dd)::int
    from (select distinct bas_dd from changed) d
  on conflict (bas_dd) do update set row_count = excluded.row_count;
  delete from trading_days where row_count = 0;
  return null;
end
$$;

-- Transition tables allow only one event per trigger, hence three.
drop trigger if exists trading_days_ins on public.daily_prices;
drop trigger if exists trading_days_upd on public.daily_prices;
drop trigger if exists trading_days_del on public.daily_prices;
create trigger trading_days_ins after insert on public.daily_prices
  referencing new table as changed for each statement execute function public.sync_trading_days();
create trigger trading_days_upd after update on public.daily_prices
  referencing new table as changed for each statement execute function public.sync_trading_days();
create trigger trading_days_del after delete on public.daily_prices
  referencing old table as changed for each statement execute function public.sync_trading_days();

create or replace view public.available_dates
with (security_invoker = true) as
  select t.bas_dd, t.row_count, true as final, null::timestamptz as as_of
  from public.trading_days t
  union all
  select l.bas_dd, count(*)::int, false, max(l.as_of)
  from public.live_prices l
  where not exists (select 1 from public.trading_days t where t.bas_dd = l.bas_dd)
  group by l.bas_dd;

notify pgrst, 'reload schema';
