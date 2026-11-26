-- us_quotes: the latest quote of each tracked US stock / ETF, one row per ticker, overwritten by market-ingest
-- (?set=us, Yahoo Finance via yahoo-finance2; not history). Tracked = mentioned in a Telegram or X post in the last 90
-- days (us_tickers, kept only if in us_symbols) plus a fixed list of ETFs in market-ingest. A ticker that drops out of
-- the list is deleted on the next successful run. US indices and Treasury yields from the same call go to
-- market_quotes (source 'yahoo').

create table if not exists public.us_quotes (
  ticker           text primary key,                -- as in us_symbols ('BRK.B'); Yahoo's symbol uses '-' ('BRK-B')
  name             text,
  exchange         text,                            -- Yahoo's fullExchangeName ('NasdaqGS', 'NYSE', 'NYSEArca')
  quote_type       text,                            -- 'EQUITY' | 'ETF'
  price            numeric not null,                -- regular-session last price
  prev_close       numeric,
  open             numeric,
  high             numeric,
  low              numeric,
  volume           bigint,
  market_cap       bigint,
  market_state     text,                            -- Yahoo's marketState: PRE, REGULAR, POST, CLOSED, ...
  market_time      timestamptz,                     -- when the price was traded (Yahoo's regularMarketTime)
  value_date       date not null,                   -- market_time's date in New York
  delay_min        int,                             -- Yahoo's exchangeDataDelayedBy (0 = real time)
  tracked_because  text not null check (tracked_because in ('mentioned', 'etf')),
  fetched_at       timestamptz not null default now()
);

alter table public.us_quotes enable row level security;
-- ~650 rows rewritten every 5 minutes during the US session: vacuum often so dead rows don't pile up
alter table public.us_quotes set (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 1000);
