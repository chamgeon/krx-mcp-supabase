-- market_quotes: the latest value of each market indicator, one row per symbol, overwritten by market-ingest (not
-- history: the current value and the previous close). Korean data only for now:
--   index  KOSPI, KOSDAQ             real time during the session, fetched every 5 min 09:00–15:40 KST
--   fx     USDKRW (원/달러, KMB)     real time 09:00–02:00 KST, fetched every 5 min
--   rate   KR1Y … KR30Y (국고채)     fetched once a day at 18:30 KST (the day's final value)
-- Change and % change aren't stored: they follow from price and prev_close.

create table if not exists public.market_quotes (
  symbol      text primary key,                                    -- 'KOSPI', 'USDKRW', 'KR10Y', ...
  kind        text not null check (kind in ('index', 'fx', 'rate')),
  name        text not null,                                       -- 'KOSPI', '원/달러', '국고채 10년'
  price       numeric not null,                                    -- index points, KRW per USD, or yield %
  prev_close  numeric,                                             -- the previous trading day's close
  unit        text not null check (unit in ('pt', 'KRW', '%')),
  value_date  date not null,                                       -- the trading day the value belongs to (KST)
  source      text not null default 'kis',
  fetched_at  timestamptz not null default now()                   -- when market-ingest stored it
);

-- Service role only, like the other tables (no policies)
alter table public.market_quotes enable row level security;
-- ~3 rows are rewritten every 5 minutes: vacuum often so the table stays a page or two
alter table public.market_quotes set (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 50);
