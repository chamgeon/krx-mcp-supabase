-- When the KIS snapshot was taken (kis-ingest runs every 5 minutes during the session).
-- Null for KRX rows, which are end-of-day.
alter table public.daily_prices add column if not exists as_of timestamptz;

create or replace view public.available_dates
with (security_invoker = true) as
  select bas_dd, count(*)::int as row_count, bool_and(source = 'krx') as final, max(as_of) as as_of
  from public.daily_prices
  group by bas_dd;
