// Pure helpers and the analyze_stock computation: no database, network or env access, so they can be unit tested
// (see analyze_test.ts). index.ts wires them into the MCP tools.

export const EOK = 100_000_000 // 1억원

export type Row = {
  bas_dd: string
  isu_cd: string
  isu_nm: string
  market: string
  sect_tp_nm: string | null
  close: number | null
  change: number | null
  fluc_rt: number | null
  open: number | null
  high: number | null
  low: number | null
  volume: number | null
  trdval: number | null
  mktcap: number | null
}

export function charts(code: string) {
  // Naver Finance chart images (unofficial URLs; they always show the *current* chart, not as-of a past date)
  const img = 'https://ssl.pstatic.net/imgfinance/chart/item/candle'
  return {
    일봉: `${img}/day/${code}.png`,
    주봉: `${img}/week/${code}.png`,
    월봉: `${img}/month/${code}.png`,
    네이버_차트페이지: `https://finance.naver.com/item/fchart.naver?code=${code}`,
    네이버_종목페이지: `https://finance.naver.com/item/main.naver?code=${code}`,
  }
}

export function present(r: Row) {
  return {
    종목코드: r.isu_cd,
    종목명: r.isu_nm,
    시장: r.market,
    소속부: r.sect_tp_nm,
    등락률: r.fluc_rt,
    종가: r.close,
    전일대비: r.change,
    시가: r.open,
    고가: r.high,
    저가: r.low,
    거래량: r.volume,
    거래대금_억원: r.trdval == null ? null : Math.round(r.trdval / EOK),
    시가총액_억원: r.mktcap == null ? null : Math.round(r.mktcap / EOK),
  }
}

export function kstTime(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' KST'
}
export function todayKstIso(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

// Accepts "2026-10-08" or "20261008"
export function normDate(d: string): string {
  const s = d.replace(/-/g, '')
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

export const eok = (v: number | null | undefined) => (v == null ? null : Math.round(v / EOK))
export const round = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d
export const pct = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || !b ? null : round((a / b - 1) * 100)

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null
}
export function stddev(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = mean(xs)!
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

// --- analyze_stock -------------------------------------------------------------------------------
// `rows` are most-recent-first: rows[0] is the analysis date, rows[1] the trading day before, ...
// Definitions match screen_stocks (supabase/migrations/*_screen_stocks.sql).

export type Signal = { code: string; detail: string }

export function analyze(
  rows: Row[],
  opts: { avg_days: number; spike_ratio: number; sideways_days: number; sideways_max_range: number },
) {
  // KRX reports days without trades (halt / no trades) with open/high/low = 0 and the close carried forward
  const traded = (r: Row) => (r.trdval ?? 0) > 0 && (r.high ?? 0) > 0
  const close = rows.map((r) => r.close ?? 0)
  const trdval = rows.map((r) => r.trdval ?? 0)
  const volume = rows.map((r) => r.volume ?? 0)
  const n = rows.length
  const t = rows[0]
  const signals: Signal[] = []
  if (!traded(t)) signals.push({ code: 'NO_TRADES', detail: '이 날 거래 없음 (거래정지 또는 무거래) — 가격 지표는 마지막 체결가 기준' })

  // Returns
  const ret = (k: number) => (n > k ? pct(close[0], close[k]) : null)
  const returns = { d1: ret(1), d5: ret(5), d10: ret(10), d20: ret(20), d60: ret(60), d120: ret(120) }

  // Trading value
  const avgPrior = (i: number, k: number) => (n >= i + 1 + k ? mean(trdval.slice(i + 1, i + 1 + k)) : null)
  const avgN = avgPrior(0, opts.avg_days)
  const avg5 = avgPrior(0, 5)
  const ratio = avgN ? round(trdval[0] / avgN) : null
  let trdvalUp = 0
  while (trdvalUp + 1 < n && trdval[trdvalUp] > trdval[trdvalUp + 1]) trdvalUp++
  const spikes = []
  for (let i = 0; i < Math.min(20, n); i++) {
    const a = avgPrior(i, opts.avg_days)
    if (a && trdval[i] / a >= opts.spike_ratio) {
      spikes.push({ date: rows[i].bas_dd, trdval_eok: eok(trdval[i]), ratio: round(trdval[i] / a), fluc_rt: rows[i].fluc_rt })
    }
  }
  const volAvgN = n >= 1 + opts.avg_days ? mean(volume.slice(1, 1 + opts.avg_days)) : null
  const volAvg5 = n >= 6 ? mean(volume.slice(1, 6)) : null
  const volRatio = volAvgN ? round(volume[0] / volAvgN) : null
  if (ratio != null && ratio >= opts.spike_ratio) {
    signals.push({ code: 'TRDVAL_SPIKE', detail: `거래대금이 직전 ${opts.avg_days}일 평균의 ${ratio}배` })
  }
  if (volRatio != null && volRatio >= opts.spike_ratio) {
    signals.push({ code: 'VOLUME_SPIKE', detail: `거래량이 직전 ${opts.avg_days}일 평균의 ${volRatio}배` })
  }
  if (trdvalUp >= 3) signals.push({ code: 'TRDVAL_RISING_STREAK', detail: `거래대금 ${trdvalUp}일 연속 증가` })

  // Moving averages (MA_k of closes ending at day i)
  const ma = (k: number, i = 0) => (n >= i + k ? mean(close.slice(i, i + k)) : null)
  const mas = Object.fromEntries(
    [5, 20, 60, 120].map((k) => {
      const v = ma(k)
      return [`ma${k}`, { value: round(v, 0), close_vs_ma_pct: pct(close[0], v), slope_5d_pct: pct(v, ma(k, 5)) }]
    }),
  )
  const [m5, m20, m60, m120] = [ma(5), ma(20), ma(60), ma(120)]
  const aligned = m5 != null && m20 != null && m60 != null && m120 != null
  const bullishAlignment = aligned && m5! > m20! && m20! > m60! && m60! > m120!
  const bearishAlignment = aligned && m5! < m20! && m20! < m60! && m60! < m120!
  if (bullishAlignment) signals.push({ code: 'MA_BULLISH_ALIGNMENT', detail: '정배열 (MA5 > MA20 > MA60 > MA120)' })
  if (bearishAlignment) signals.push({ code: 'MA_BEARISH_ALIGNMENT', detail: '역배열 (MA5 < MA20 < MA60 < MA120)' })
  const p5 = ma(5, 1), p20 = ma(20, 1)
  if (m5 != null && m20 != null && p5 != null && p20 != null) {
    if (p5 <= p20 && m5 > m20) signals.push({ code: 'GOLDEN_CROSS_5_20', detail: 'MA5가 오늘 MA20을 상향 돌파' })
    if (p5 >= p20 && m5 < m20) signals.push({ code: 'DEAD_CROSS_5_20', detail: 'MA5가 오늘 MA20을 하향 돌파' })
  }

  // Breakouts: close > highest high of the prior k days
  const breakouts = Object.fromEntries(
    [20, 60, 120].map((k) => {
      if (n <= k) return [`d${k}`, null]
      const prior = rows.slice(1, k + 1).filter(traded)
      if (prior.length === 0) return [`d${k}`, null]
      const hi = Math.max(...prior.map((r) => r.high!))
      const lo = Math.min(...prior.map((r) => r.low!))
      const broke = traded(t) && close[0] > hi
      if (broke) signals.push({ code: `BREAKOUT_${k}D`, detail: `종가가 직전 ${k}일 최고가(${hi}) 돌파` })
      return [`d${k}`, { prior_high: hi, prior_low: lo, breakout: broke, close_vs_high_pct: pct(close[0], hi) }]
    }),
  )

  // Volatility and streaks
  const fluc20 = rows.slice(0, 20).map((r) => Number(r.fluc_rt ?? 0))
  const vol20 = stddev(fluc20)
  const trs = []
  for (let i = 0; i < Math.min(14, n - 1); i++) {
    const r = rows[i], pc = close[i + 1]
    if (!traded(r)) continue
    trs.push(Math.max((r.high ?? 0) - (r.low ?? 0), Math.abs((r.high ?? 0) - pc), Math.abs((r.low ?? 0) - pc)))
  }
  let up = 0, down = 0
  while (up + 1 < n && close[up] > close[up + 1]) up++
  while (down + 1 < n && close[down] < close[down + 1]) down++
  if (up >= 3) signals.push({ code: 'PRICE_UP_STREAK', detail: `${up}일 연속 상승` })
  if (down >= 3) signals.push({ code: 'PRICE_DOWN_STREAK', detail: `${down}일 연속 하락` })

  // Consolidation (box) and price / trading-value divergence
  let consolidation = null
  const sd = opts.sideways_days
  if (n >= sd) {
    const box = rows.slice(0, sd)
    const tradedBox = box.filter(traded)
    const hi = tradedBox.length ? Math.max(...tradedBox.map((r) => r.high!)) : null
    const lo = tradedBox.length ? Math.min(...tradedBox.map((r) => r.low!)) : null
    const range = pct(hi, lo)
    const recent = mean(trdval.slice(0, 5))
    const early = mean(trdval.slice(5, sd))
    const growth = recent != null && early ? round(recent / early) : null
    const priceChange = pct(close[0], close[sd - 1])
    const isBox = range != null && range <= opts.sideways_max_range
    consolidation = {
      days: sd,
      box_high: hi,
      box_low: lo,
      range_pct: range,
      is_consolidating: isBox,
      price_change_pct: priceChange,
      trdval_recent5_avg_eok: eok(recent),
      trdval_earlier_avg_eok: eok(early),
      trdval_growth: growth,
    }
    if (isBox && growth != null && growth >= 1.5) {
      signals.push({ code: 'BOX_WITH_RISING_TRDVAL', detail: `${sd}일 박스권(${range}%) 속 거래대금 ${growth}배 증가 — 매집 가능성` })
    } else if (isBox) {
      signals.push({ code: 'CONSOLIDATION', detail: `${sd}일 고저 범위 ${range}%` })
    }
    if (priceChange != null && growth != null) {
      if (priceChange >= 5 && growth <= 0.7) {
        signals.push({ code: 'RALLY_ON_FADING_TRDVAL', detail: `${sd}일 ${priceChange}% 상승했지만 최근 거래대금은 ${growth}배로 감소` })
      }
      if (priceChange <= -5 && growth >= 1.5) {
        signals.push({ code: 'DECLINE_ON_RISING_TRDVAL', detail: `${sd}일 ${priceChange}% 하락 중 거래대금 ${growth}배 증가 — 매도 압력` })
      }
    }
  }

  return {
    date: t.bas_dd,
    code: t.isu_cd,
    name: t.isu_nm,
    market: t.market,
    history_days: n,
    traded_on_date: traded(t),
    price: { close: t.close, open: t.open, high: t.high, low: t.low, fluc_rt: t.fluc_rt, mktcap_eok: eok(t.mktcap) },
    returns_pct: returns,
    trading_value: {
      today_eok: eok(trdval[0]),
      avg5_prior_eok: eok(avg5),
      [`avg${opts.avg_days}_prior_eok`]: eok(avgN),
      ratio_vs_avg: ratio,
      ratio_vs_avg5: avg5 ? round(trdval[0] / avg5) : null,
      consecutive_up_days: trdvalUp,
      spikes_last_20d: spikes,
    },
    volume: {
      today: volume[0],
      avg5_prior: round(volAvg5, 0),
      [`avg${opts.avg_days}_prior`]: round(volAvgN, 0),
      ratio_vs_avg: volRatio,
      ratio_vs_avg5: volAvg5 ? round(volume[0] / volAvg5) : null,
    },
    moving_averages: { ...mas, bullish_alignment: bullishAlignment, bearish_alignment: bearishAlignment },
    breakouts,
    volatility: {
      daily_stddev_20d_pct: round(vol20),
      annualized_pct: round(vol20 == null ? null : vol20 * Math.sqrt(250)),
      atr14_pct: trs.length && close[0] ? round((mean(trs)! / close[0]) * 100) : null,
    },
    streaks: { consecutive_up_days: up, consecutive_down_days: down },
    consolidation,
    signals,
  }
}

