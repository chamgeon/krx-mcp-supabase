-- KRX 일별매매정보 (KOSPI + KOSDAQ) 저장 테이블
create table if not exists public.daily_prices (
  bas_dd      date    not null,          -- 기준일자
  isu_cd      text    not null,          -- 종목코드 (6자리)
  isu_nm      text    not null,          -- 종목명
  market      text    not null,          -- KOSPI / KOSDAQ
  sect_tp_nm  text,                      -- 소속부 (코스닥 우량기업부 등)
  close       bigint,                    -- 종가
  change      bigint,                    -- 전일대비
  fluc_rt     numeric(8,2),              -- 등락률 (%)
  open        bigint,                    -- 시가
  high        bigint,                    -- 고가
  low         bigint,                    -- 저가
  volume      bigint,                    -- 거래량
  trdval      bigint,                    -- 거래대금 (원)
  mktcap      bigint,                    -- 시가총액 (원)
  list_shrs   bigint,                    -- 상장주식수
  primary key (bas_dd, isu_cd)
);

create index if not exists daily_prices_date_rate_idx on public.daily_prices (bas_dd, fluc_rt desc);
create index if not exists daily_prices_code_date_idx on public.daily_prices (isu_cd, bas_dd desc);

-- RLS on with no policies: only the service role (used by the Edge Functions) can read/write.
alter table public.daily_prices enable row level security;

create or replace view public.available_dates
with (security_invoker = true) as
  select bas_dd, count(*)::int as row_count
  from public.daily_prices
  group by bas_dd;
