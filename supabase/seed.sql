-- Local test data, loaded by `supabase start` / `supabase db reset` (never applied to production).
--
-- 9 made-up stocks (codes 9000xx) over the weekdays 2026-05-01 .. 2026-11-13 (~140 trading days), each shaped to
-- trigger one screen_stocks / analyze_stock signal on the last day, 2026-11-13. k = trading days before that day
-- (k = 0 is 2026-11-13). Tests in supabase/tests/ rely on these shapes; change both together.
--
--   900001 돌파전자    KOSPI   flat 10,000, then 11,000 on the last day        → 20/60/120-day breakout, +10%
--   900002 급증바이오  KOSDAQ  flat; 거래대금/거래량 5× on the last day         → trdval / volume spike
--   900003 박스화학    KOSPI   20-day box 19,900–20,200, 거래대금 2× last 5 days → box with rising 거래대금
--   900004 정지중공업  KOSDAQ  halted on the last day (high/low/거래대금 0)     → excluded unless include_untraded
--   900005 상승제약    KOSPI   close +10 every day                            → long up streak (and daily breakouts)
--   900006 신규상장    KOSDAQ  listed 10 days ago                              → short history: nulls, not NaN
--   900007 변동금속    KOSPI   alternates 10,000 / 10,500                      → ~5% daily volatility
--   900008 급등테크    KOSDAQ  flat 1,000, then 1,300 on the last day          → +30%: get_daily_movers sheet1
--   900009 대형강세    KOSPI   flat 50,000, then 54,000; 거래대금 600억 daily  → +8% and ≥ 500억: sheet2
--
-- Plus a provisional KIS day (live_prices, 2026-11-16 mid-session) and one stale live_prices row for 2026-11-13 that
-- the prices view must hide because KRX already has that day.

with days as (
  select d::date as bas_dd, count(*) over (order by d desc) - 1 as k
  from generate_series('2026-05-01'::date, '2026-11-13'::date, interval '1 day') d
  where extract(isodow from d) < 6
),
raw as (
  select d.bas_dd, s.isu_cd, s.isu_nm, s.market, v.close, v.high, v.low, v.volume, v.trdval, s.mktcap
  from days d
  cross join (values
    ('900001', '돌파전자',   'KOSPI',  1000000000000),
    ('900002', '급증바이오', 'KOSDAQ',  100000000000),
    ('900003', '박스화학',   'KOSPI',   100000000000),
    ('900004', '정지중공업', 'KOSDAQ',  100000000000),
    ('900005', '상승제약',   'KOSPI',   100000000000),
    ('900006', '신규상장',   'KOSDAQ',  100000000000),
    ('900007', '변동금속',   'KOSPI',   100000000000),
    ('900008', '급등테크',   'KOSDAQ',  100000000000),
    ('900009', '대형강세',   'KOSPI',   100000000000)
  ) as s(isu_cd, isu_nm, market, mktcap)
  -- per stock and day: {close, high, low, volume, trdval}; null = not listed yet
  cross join lateral (select case
       when s.isu_cd = '900001' then
         case when d.k = 0 then array[11000, 11050, 10950, 1000000, 10000000000] else array[10000, 10100, 9900, 1000000, 10000000000] end
       when s.isu_cd = '900002' then
         case when d.k = 0 then array[5000, 5050, 4950, 5000000, 50000000000] else array[5000, 5050, 4950, 1000000, 10000000000] end
       when s.isu_cd = '900003' then
         case when d.k >= 20 then array[15000, 15100, 14900, 1000000, 10000000000]
              when d.k >= 5  then array[20000 + (d.k % 2) * 100, 20100 + (d.k % 2) * 100, 19900 + (d.k % 2) * 100, 1000000, 10000000000]
              else                array[20000 + (d.k % 2) * 100, 20100 + (d.k % 2) * 100, 19900 + (d.k % 2) * 100, 2000000, 20000000000] end
       when s.isu_cd = '900004' then
         case when d.k = 0 then array[8000, 0, 0, 0, 0] else array[8000, 8080, 7920, 1000000, 10000000000] end
       when s.isu_cd = '900005' then
         array[2400 - 10 * d.k, 2405 - 10 * d.k, 2395 - 10 * d.k, 1000000, 10000000000]
       when s.isu_cd = '900006' then
         case when d.k < 10 then array[3000, 3030, 2970, 1000000, 10000000000] end
       when s.isu_cd = '900007' then
         case when d.k % 2 = 0 then array[10500, 10600, 10400, 1000000, 10000000000] else array[10000, 10100, 9900, 1000000, 10000000000] end
       when s.isu_cd = '900008' then
         case when d.k = 0 then array[1300, 1320, 1250, 1000000, 10000000000] else array[1000, 1010, 990, 1000000, 10000000000] end
       when s.isu_cd = '900009' then
         case when d.k = 0 then array[54000, 54500, 53000, 1000000, 60000000000] else array[50000, 50500, 49500, 1000000, 60000000000] end
     end::bigint[] as a
  ) x
  cross join lateral (select x.a[1] as close, x.a[2] as high, x.a[3] as low, x.a[4] as volume, x.a[5] as trdval) v
  where x.a is not null
)
insert into public.daily_prices
  (bas_dd, isu_cd, isu_nm, market, sect_tp_nm, close, change, fluc_rt, open, high, low, volume, trdval, mktcap, list_shrs, source)
select bas_dd, isu_cd, isu_nm, market, null,
       close,
       close - coalesce(lag(close) over w, close),
       round((close::numeric / coalesce(lag(close) over w, close) - 1) * 100, 2),
       case when trdval = 0 then 0 else close end, -- open: 0 on a halted day, like KRX
       high, low, volume, trdval, mktcap, mktcap / close, 'krx'
from raw
window w as (partition by isu_cd order by bas_dd);

-- Provisional same-day KIS snapshot for Monday 2026-11-16, 11:00 KST (~31% of the session): unchanged prices.
insert into public.live_prices
  (bas_dd, isu_cd, isu_nm, market, close, change, fluc_rt, open, high, low, volume, trdval, mktcap, list_shrs, source, as_of)
select '2026-11-16', isu_cd, isu_nm, market, close, 0, 0, close, close, close, volume / 3, trdval / 3, mktcap, list_shrs,
       'kis', '2026-11-16T02:00:00Z'
from public.daily_prices
where bas_dd = '2026-11-13' and trdval > 0;

-- Stale KIS row for a day KRX already published: the prices view must not show it.
insert into public.live_prices (bas_dd, isu_cd, isu_nm, market, close, fluc_rt, high, low, volume, trdval, source, as_of)
values ('2026-11-13', '900001', '돌파전자', 'KOSPI', 99999, 0, 99999, 99999, 1, 1, 'kis', '2026-11-13T05:00:00Z');

-- Telegram: two collected channels with a few posts at fixed times. last_polled_at is far in the future so no tool
-- ever thinks a channel is stale and fetches t.me during tests.
insert into public.telegram_channels (username, title, last_polled_at, last_msg_id) values
  ('testchannel_a', 'Test Channel A', '2100-01-01T00:00:00Z', 2),
  ('testchannel_b', 'Test Channel B', '2100-01-01T00:00:00Z', 1);

insert into public.telegram_messages (username, msg_id, ts, text, views, stock_codes) values
  ('testchannel_a', 1, '2026-11-13T01:00:00Z', '돌파전자 신고가 돌파, HBM 수주 기대', 1200, '{900001}'),
  ('testchannel_a', 2, '2026-11-13T02:00:00Z', '급증바이오 거래대금 급증', 800, '{900002}'),
  ('testchannel_b', 1, '2026-11-12T00:00:00Z', 'HBM 관련 업황 코멘트', 300, '{}');
