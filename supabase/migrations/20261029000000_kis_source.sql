-- KIS (한국투자증권) provides same-day provisional rows; KRX overwrites them with the official numbers
-- the next morning. `source` records which one a row came from.
alter table public.daily_prices add column if not exists source text not null default 'krx';

-- final = every row of the day comes from KRX
create or replace view public.available_dates
with (security_invoker = true) as
  select bas_dd, count(*)::int as row_count, bool_and(source = 'krx') as final
  from public.daily_prices
  group by bas_dd;

-- KIS OAuth access token (valid 24h; KIS asks clients to reuse it rather than re-issue)
create table if not exists public.kis_token (
  id            int         primary key default 1 check (id = 1),
  access_token  text        not null,
  expires_at    timestamptz not null
);

-- RLS on with no policies: only the service role (used by the Edge Functions) can read/write.
alter table public.kis_token enable row level security;
