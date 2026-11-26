// Saves real API responses as test fixtures for the ingest parsers. Uses the real keys in supabase/.env (never printed
// or saved). Rerun it when an API changes its format: save the new response, watch the parser tests fail, fix the
// parser.
//
//   deno task fixtures                 # all: KRX (both markets), KIS, Telegram
//   deno task fixtures krx 20261113    # KRX for one day (default 20261113)
//   deno task fixtures kis             # KIS snapshot now (live during the session, last close otherwise)
//   deno task fixtures telegram ehdwl  # one public channel's preview page (default ehdwl)
//   deno task fixtures market          # KIS: KOSPI/KOSDAQ, KRW/USD, KR government bond yields (market-ingest)
//
// Each run costs: KRX 2 calls (daily limit ~10,000), KIS 1 token + 1 quote call, Telegram 1 page; market: KIS 1 token
// + 10 calls.

const ROOT = new URL('../supabase/functions/', import.meta.url)
const KRX_DIR = new URL('krx-ingest/fixtures/', ROOT)
const KIS_DIR = new URL('kis-ingest/fixtures/', ROOT)
const TG_DIR = new URL('_shared/fixtures/', ROOT)

function loadEnv(): Record<string, string> {
  const text = Deno.readTextFileSync(new URL('../supabase/.env', import.meta.url))
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

function need(env: Record<string, string>, name: string): string {
  if (!env[name]) throw new Error(`${name} is missing from supabase/.env`)
  return env[name]
}

async function save(dir: URL, name: string, text: string) {
  await Deno.mkdir(dir, { recursive: true })
  const file = new URL(name, dir)
  await Deno.writeTextFile(file, text)
  console.log(`saved ${file.pathname.split('/supabase/')[1]} (${(text.length / 1024).toFixed(0)} KB)`)
}

// ---- KRX ------------------------------------------------------------------------------------------

async function krx(env: Record<string, string>, basDd: string) {
  const key = need(env, 'KRX_API_KEY')
  for (const path of ['stk_bydd_trd', 'ksq_bydd_trd']) {
    const res = await fetch(`https://data-dbg.krx.co.kr/svc/apis/sto/${path}?basDd=${basDd}`, { headers: { AUTH_KEY: key } })
    const text = await res.text()
    if (!res.ok) throw new Error(`KRX ${path}: HTTP ${res.status} ${text.slice(0, 200)}`)
    // Saved byte-for-byte as KRX sent it
    await save(KRX_DIR, `${path}_${basDd}.json`, text)
  }
}

// ---- KIS ------------------------------------------------------------------------------------------

// A mix of stocks that exercise the parser: big caps, a preferred share, KOSDAQ, the day's biggest movers both ways,
// a halted stock, and a code that doesn't exist (KIS returns an empty row for it). Picked from the saved KRX fixture.
async function kisCodes(basDd: string): Promise<string[]> {
  const read = async (path: string) =>
    JSON.parse(await Deno.readTextFile(new URL(`${path}_${basDd}.json`, KRX_DIR))).OutBlock_1 as Record<string, string>[]
  const all = [...await read('stk_bydd_trd'), ...await read('ksq_bydd_trd')]
  const n = (s: string) => Number(s.replace(/,/g, ''))
  const byRate = [...all].sort((a, b) => n(b.FLUC_RT) - n(a.FLUC_RT))
  const halted = all.filter((r) => n(r.ACC_TRDVAL) === 0)
  const picks = new Set([
    '005930', '005935', '000660', '373220', '035420', // 삼성전자, 삼성전자우, SK하이닉스, LG에너지솔루션, NAVER
    '247540', '196170', '028300', // KOSDAQ: 에코프로비엠, 알테오젠, HLB
    ...byRate.slice(0, 8).map((r) => r.ISU_CD), // biggest gainers (likely 상한가)
    ...byRate.slice(-5).map((r) => r.ISU_CD), // biggest losers
    ...halted.slice(0, 3).map((r) => r.ISU_CD), // 거래정지 / no trades
  ])
  for (const r of all) {
    if (picks.size >= 29) break
    picks.add(r.ISU_CD)
  }
  return [...picks].slice(0, 29).concat('999999') // 30 = the per-call maximum
}

async function kis(env: Record<string, string>, basDd: string) {
  const appkey = need(env, 'KIS_APP_KEY')
  const appsecret = need(env, 'KIS_APP_SECRET')
  const base = 'https://openapi.koreainvestment.com:9443'
  const tok = await fetch(`${base}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey, appsecret }),
  })
  if (!tok.ok) throw new Error(`KIS token: HTTP ${tok.status} ${(await tok.text()).slice(0, 200)}`)
  const { access_token } = await tok.json()

  const codes = await kisCodes(basDd)
  const params = new URLSearchParams()
  codes.forEach((c, i) => {
    params.set(`FID_COND_MRKT_DIV_CODE_${i + 1}`, 'J')
    params.set(`FID_INPUT_ISCD_${i + 1}`, c)
  })
  const res = await fetch(`${base}/uapi/domestic-stock/v1/quotations/intstock-multprice?${params}`, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      authorization: `Bearer ${access_token}`,
      appkey,
      appsecret,
      tr_id: 'FHKST11300006',
      custtype: 'P',
    },
  })
  const body = await res.json()
  if (!res.ok || body.rt_cd !== '0') throw new Error(`KIS: HTTP ${res.status} ${body.msg_cd ?? ''} ${body.msg1 ?? ''}`)
  // The response body as KIS sent it, plus what was asked for (no token or keys)
  const fetchedAt = new Date().toISOString()
  await save(KIS_DIR, `intstock_multprice_${fetchedAt.slice(0, 10).replace(/-/g, '')}.json`,
    JSON.stringify({ fetched_at: fetchedAt, requested_codes: codes, krx_list_from: basDd, body }, null, 1))
}

// ---- market-ingest (KIS: KOSPI/KOSDAQ, KRW/USD, KR government bond yields) --------------------------

async function market(env: Record<string, string>) {
  const appkey = need(env, 'KIS_APP_KEY')
  const appsecret = need(env, 'KIS_APP_SECRET')
  const base = 'https://openapi.koreainvestment.com:9443'
  const tok = await fetch(`${base}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey, appsecret }),
  })
  if (!tok.ok) throw new Error(`KIS token: HTTP ${tok.status} ${(await tok.text()).slice(0, 200)}`)
  const { access_token } = await tok.json()
  const get = async (path: string, trId: string, params: Record<string, string>) => {
    await new Promise((r) => setTimeout(r, 250))
    const res = await fetch(`${base}${path}?${new URLSearchParams(params)}`, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', authorization: `Bearer ${access_token}`, appkey, appsecret, tr_id: trId, custtype: 'P' },
    })
    return { params, body: await res.json() }
  }
  const ymd = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '')
  const chart = (div: string, code: string) =>
    get('/uapi/overseas-price/v1/quotations/inquire-daily-chartprice', 'FHKST03030100', {
      FID_COND_MRKT_DIV_CODE: div, FID_INPUT_ISCD: code, FID_INPUT_DATE_1: ymd(Date.now() - 14 * 86400_000), FID_INPUT_DATE_2: ymd(Date.now()), FID_PERIOD_DIV_CODE: 'D',
    })
  const index = (code: string) =>
    get('/uapi/domestic-stock/v1/quotations/inquire-index-price', 'FHPUP02100000', { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: code })
  const out: Record<string, unknown> = {}
  for (const c of ['0001', '1001']) out[`index_${c}`] = await index(c)
  out['fx_FX@KRW'] = await chart('X', 'FX@KRW')
  // 국고채 1/3/5/10/20/30년, plus an unknown code (what an empty answer looks like)
  for (const c of ['Y0104', 'Y0101', 'Y0105', 'Y0106', 'Y0116', 'Y0117', 'Y0999']) out[`bond_${c}`] = await chart('I', c)
  const fetchedAt = new Date().toISOString()
  const stamp = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '_')
  await save(new URL('market-ingest/fixtures/', ROOT), `kis_market_${stamp}.json`, JSON.stringify({ fetched_at: fetchedAt, responses: out }, null, 1))
}

// ---- Telegram -------------------------------------------------------------------------------------

async function telegram(channel: string) {
  const res = await fetch(`https://t.me/s/${channel}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kr-stock-mcp/1.0; public channel reader)', 'Accept-Language': 'ko,en;q=0.8' },
    redirect: 'manual',
  })
  if (res.status !== 200) throw new Error(`t.me/s/${channel}: HTTP ${res.status} (no public preview?)`)
  await save(TG_DIR, `tme_s_${channel}.html`, await res.text())
}

// ---- main -----------------------------------------------------------------------------------------

const [what = 'all', arg] = Deno.args
const env = what === 'telegram' ? {} : loadEnv()
const basDd = what === 'krx' && arg ? arg : '20261113'
if (what === 'all' || what === 'krx') await krx(env, basDd)
if (what === 'all' || what === 'kis') await kis(env, basDd)
if (what === 'all' || what === 'market') await market(env)
if (what === 'all' || what === 'telegram') await telegram(what === 'telegram' && arg ? arg : 'ehdwl')
