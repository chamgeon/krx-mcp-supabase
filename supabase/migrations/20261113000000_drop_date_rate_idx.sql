-- get_daily_movers reads one day (~2,800 rows); daily_prices_screen_idx already covers (bas_dd) + fluc_rt, so this
-- index only added size (83 MB) and write cost on every 5-minute KIS upsert.
drop index if exists public.daily_prices_date_rate_idx;
