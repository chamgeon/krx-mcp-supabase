-- screen_stocks v5: handle days without trades.
-- KRX reports a stock that didn't trade (trading halt, or simply no trades) with open/high/low = 0 and the previous
-- close carried forward. v4 took those zeros as prices, so a stock halted for 120 days had a "120-day high" of 0 and
-- showed up as a breakout.
--  * zero high/low are ignored (treated as null) in every high/low calculation
--  * a stock with 거래대금 = 0 on p_date is never a breakout
--  * stocks with 거래대금 = 0 on p_date are left out unless p_include_untraded = true (new parameter)

-- the signature changes, so replace rather than "create or replace"
drop function if exists public.screen_stocks;

create or replace function public.screen_stocks(
  p_date                       date    default null,     -- null = latest loaded day
  p_market                     text    default null,     -- 'KOSPI' | 'KOSDAQ' | null (both)
  p_include_untraded           boolean default false,    -- include stocks with 거래대금 = 0 on p_date (halted / no trades)
  -- daily change / size
  p_min_fluc_rt                numeric default null,     -- 등락률 % >=
  p_max_fluc_rt                numeric default null,     -- 등락률 % <=
  p_min_trdval                 bigint  default null,     -- 거래대금 (원) >=
  p_min_mktcap                 bigint  default null,     -- 시가총액 (원) >=
  -- trading value / volume spike vs prior N-day average
  p_avg_days                   int     default 20,
  p_min_trdval_ratio           numeric default null,     -- today / prior avg >=
  p_min_volume                 bigint  default null,     -- 거래량 (주) >=
  p_min_volume_ratio           numeric default null,     -- 거래량 today / prior avg_days avg >=
  -- consecutive trading value increases
  p_min_trdval_up_days         int     default null,
  -- sideways price + rising trading value
  p_sideways_days              int     default 20,       -- box length, including p_date
  p_sideways_recent_days       int     default 5,        -- "recent" part of the box
  p_max_sideways_range         numeric default null,     -- (max high - min low) / min low % <=
  p_min_sideways_trdval_growth numeric default null,     -- recent avg 거래대금 / earlier avg in the box >=
  -- breakouts: close > highest high of the prior N days, for every N listed (subset of 20, 60, 120)
  p_breakout_days              int[]   default null,     -- 60/120-day highs are only computed when listed here
  -- consecutive price increases / volatility
  p_min_price_up_days          int     default null,
  p_volatility_days            int     default 20,
  p_min_volatility             numeric default null,     -- stddev of daily 등락률 (%) >=
  p_max_volatility             numeric default null,     -- stddev of daily 등락률 (%) <=
  -- output
  p_sort                       text    default 'fluc_rt',
  p_limit                      int     default 100
)
returns table (
  bas_dd              date,
  isu_cd              text,
  isu_nm              text,
  market              text,
  close               bigint,
  fluc_rt             numeric,
  trdval              bigint,
  volume              bigint,
  mktcap              bigint,
  history_days        int,                 -- days of history in the short window
  trdval_avg          numeric,
  trdval_ratio        numeric,
  volume_avg          numeric,
  volume_ratio        numeric,
  trdval_up_days      int,
  price_up_days       int,
  price_down_days     int,
  volatility          numeric,
  sideways_range_pct  numeric,
  sideways_trdval_growth numeric,
  high_20             bigint,
  high_60             bigint,
  high_120            bigint,
  breakout_20         boolean,
  breakout_60         boolean,
  breakout_120        boolean
)
language plpgsql
stable
set search_path = public
set work_mem = '64MB'   -- keep the per-stock window sort in memory
as $$
#variable_conflict use_column
declare
  v_day   date := coalesce(p_date, (select max(bas_dd) from daily_prices));
  -- short window: everything except the 60/120-day highs
  v_short int  := greatest(21, p_avg_days + 1, p_sideways_days, p_volatility_days);
  v_long  int  := case when p_breakout_days && array[120] then 121
                       when p_breakout_days && array[60]  then 61
                       else 0 end;
  v_dates date[];   -- last trading days up to v_day, newest first: v_dates[1] = v_day
begin
  -- bounded scan so we never read the whole table
  select array_agg(s.bas_dd order by s.bas_dd desc) into v_dates from (
    select d.bas_dd from daily_prices d
    where d.bas_dd <= v_day and d.bas_dd > v_day - (greatest(v_short, v_long) * 2 + 30)
    group by d.bas_dd
    order by d.bas_dd desc
    limit greatest(v_short, v_long)
  ) s;

  return query
  with recent as materialized (
    -- Plain range read of daily_prices_screen_idx (index-only, sequential), then sort in memory.
    -- Without "materialized" the planner walks daily_prices_code_date_idx instead to skip the sort,
    -- which fetches every row from the heap one by one (~8s on the free plan).
    select d.bas_dd, d.isu_cd, d.close, nullif(d.high, 0) as high, nullif(d.low, 0) as low, d.fluc_rt, d.volume, d.trdval
    from daily_prices d
    where d.bas_dd between v_dates[least(v_short, cardinality(v_dates))] and v_day
  ),
  base as (
    select r.*,
           row_number() over w as rn,
           -- false on the oldest row in the window, so streaks are capped at v_short - 1 days
           coalesce(r.trdval > lead(r.trdval) over w, false) as trdval_up,
           coalesce(r.close  > lead(r.close)  over w, false) as price_up,
           coalesce(r.close  < lead(r.close)  over w, false) as price_down
    from recent r
    window w as (partition by r.isu_cd order by r.bas_dd desc)
  ),
  agg as (
    -- one pass per stock; "today" values are the rn = 1 row
    select b.isu_cd,
           max(b.close)   filter (where b.rn = 1) as close,
           max(b.fluc_rt) filter (where b.rn = 1) as fluc_rt,
           max(b.trdval)  filter (where b.rn = 1) as trdval,
           max(b.volume)  filter (where b.rn = 1) as volume,
           count(*)::int as history_days,
           avg(b.trdval) filter (where b.rn between 2 and p_avg_days + 1) as trdval_avg,
           avg(b.volume) filter (where b.rn between 2 and p_avg_days + 1) as volume_avg,
           coalesce(min(b.rn) filter (where not b.trdval_up),  count(*)) - 1 as trdval_up_days,
           coalesce(min(b.rn) filter (where not b.price_up),   count(*)) - 1 as price_up_days,
           coalesce(min(b.rn) filter (where not b.price_down), count(*)) - 1 as price_down_days,
           stddev_samp(b.fluc_rt) filter (where b.rn <= p_volatility_days) as volatility,
           max(b.high) filter (where b.rn <= p_sideways_days) as box_high,
           min(b.low)  filter (where b.rn <= p_sideways_days) as box_low,
           avg(b.trdval) filter (where b.rn <= p_sideways_recent_days) as box_recent_trdval,
           avg(b.trdval) filter (where b.rn > p_sideways_recent_days and b.rn <= p_sideways_days) as box_early_trdval,
           count(*) filter (where b.rn <= p_sideways_days) as box_days,
           max(b.high) filter (where b.rn between 2 and 21) as high_20
    from base b
    group by b.isu_cd
    having max(b.bas_dd) = v_day   -- traded on the analysis date
  ),
  long_highs as (
    -- 60/120-day highs: a plain grouped max over the prior trading days, no sort or window.
    -- Empty unless breakout_days asks for them. has_N = the stock existed N trading days ago.
    select d.isu_cd,
           max(nullif(d.high, 0)) filter (where d.bas_dd >= v_dates[61]) as high_60,
           max(nullif(d.high, 0)) as high_120,
           min(d.bas_dd) <= v_dates[61]  as has_60,
           min(d.bas_dd) <= v_dates[121] as has_120
    from daily_prices d
    where v_long > 0
      and d.bas_dd >= v_dates[least(v_long, cardinality(v_dates))] and d.bas_dd < v_day
    group by d.isu_cd
  ),
  metrics as (
    select v_day as bas_dd, a.isu_cd, t.isu_nm, t.market, a.close, a.fluc_rt, a.trdval, a.volume, t.mktcap,
           a.history_days,
           round(a.trdval_avg, 0) as trdval_avg,
           round(a.trdval / nullif(a.trdval_avg, 0), 2) as trdval_ratio,
           round(a.volume_avg, 0) as volume_avg,
           round(a.volume / nullif(a.volume_avg, 0), 2) as volume_ratio,
           a.trdval_up_days::int,
           a.price_up_days::int,
           a.price_down_days::int,
           round(a.volatility, 2) as volatility,
           case when a.box_days >= p_sideways_days
                then round((a.box_high - a.box_low)::numeric / nullif(a.box_low, 0) * 100, 2) end as sideways_range_pct,
           case when a.box_days >= p_sideways_days
                then round(a.box_recent_trdval / nullif(a.box_early_trdval, 0), 2) end as sideways_trdval_growth,
           a.high_20,
           case when v_long >= 61  then h.high_60  end as high_60,
           case when v_long >= 121 then h.high_120 end as high_120,
           -- null when there isn't enough history to call it a breakout
           -- no trades today (KRX reports high/low = 0 and carries the close forward) is never a breakout
           case when a.history_days > 20 and a.trdval > 0 then a.close > a.high_20 end as breakout_20,
           case when v_long >= 61  and h.has_60  and a.trdval > 0 then a.close > h.high_60  end as breakout_60,
           case when v_long >= 121 and h.has_120 and a.trdval > 0 then a.close > h.high_120 end as breakout_120
    from agg a
    -- name / market / 시총 from the analysis day only (primary key lookups)
    join daily_prices t on t.bas_dd = v_day and t.isu_cd = a.isu_cd
    left join long_highs h on h.isu_cd = a.isu_cd
  )
  select m.*
  from metrics m
  where (p_market is null or m.market = p_market)
    and (p_include_untraded or m.trdval > 0)
    and (p_min_fluc_rt is null or m.fluc_rt >= p_min_fluc_rt)
    and (p_max_fluc_rt is null or m.fluc_rt <= p_max_fluc_rt)
    and (p_min_trdval is null or m.trdval >= p_min_trdval)
    and (p_min_mktcap is null or m.mktcap >= p_min_mktcap)
    and (p_min_trdval_ratio is null or m.trdval_ratio >= p_min_trdval_ratio)
    and (p_min_volume is null or m.volume >= p_min_volume)
    and (p_min_volume_ratio is null or m.volume_ratio >= p_min_volume_ratio)
    and (p_min_trdval_up_days is null or m.trdval_up_days >= p_min_trdval_up_days)
    and (p_max_sideways_range is null or m.sideways_range_pct <= p_max_sideways_range)
    and (p_min_sideways_trdval_growth is null or m.sideways_trdval_growth >= p_min_sideways_trdval_growth)
    and (p_breakout_days is null or (
          (not 20  = any(p_breakout_days) or m.breakout_20  is true) and
          (not 60  = any(p_breakout_days) or m.breakout_60  is true) and
          (not 120 = any(p_breakout_days) or m.breakout_120 is true)))
    and (p_min_price_up_days is null or m.price_up_days >= p_min_price_up_days)
    and (p_min_volatility is null or m.volatility >= p_min_volatility)
    and (p_max_volatility is null or m.volatility <= p_max_volatility)
  order by
    case p_sort
      when 'fluc_rt'                then m.fluc_rt
      when 'trdval'                 then m.trdval::numeric
      when 'trdval_ratio'           then m.trdval_ratio
      when 'volume'                 then m.volume::numeric
      when 'volume_ratio'           then m.volume_ratio
      when 'trdval_up_days'         then m.trdval_up_days::numeric
      when 'price_up_days'          then m.price_up_days::numeric
      when 'volatility'             then m.volatility
      when 'sideways_trdval_growth' then m.sideways_trdval_growth
      when 'mktcap'                 then m.mktcap::numeric
    end desc nulls last,
    -- tight boxes first when sorting by range
    case when p_sort = 'sideways_range_pct' then m.sideways_range_pct end asc nulls last,
    m.fluc_rt desc nulls last
  limit least(greatest(p_limit, 1), 500);
end
$$;


-- Only the Edge Functions (service role) call this.
revoke execute on function public.screen_stocks from public, anon, authenticated;
grant execute on function public.screen_stocks to service_role;
