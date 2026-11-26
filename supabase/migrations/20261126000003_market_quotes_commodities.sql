-- market_quotes: gold and silver (COMEX front-month futures; Yahoo has no spot price) and Bitcoin, from Yahoo Finance
-- (market-ingest ?set=global, every 10 min, every day). New kinds 'commodity' and 'crypto', and the unit 'USD'
-- (USD per troy ounce for gold and silver, USD per coin for Bitcoin).

alter table public.market_quotes drop constraint if exists market_quotes_kind_check;
alter table public.market_quotes add constraint market_quotes_kind_check
  check (kind in ('index', 'fx', 'rate', 'commodity', 'crypto'));

alter table public.market_quotes drop constraint if exists market_quotes_unit_check;
alter table public.market_quotes add constraint market_quotes_unit_check
  check (unit in ('pt', 'KRW', '%', 'USD'));
