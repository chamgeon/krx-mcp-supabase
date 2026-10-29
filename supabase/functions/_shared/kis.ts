// KIS (한국투자증권) Open API client shared by kis-ingest and mcp.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

const KIS_BASE = 'https://openapi.koreainvestment.com:9443'
const KIS_APP_KEY = Deno.env.get('KIS_APP_KEY')!
const KIS_APP_SECRET = Deno.env.get('KIS_APP_SECRET')!

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Access tokens last 24h and KIS limits issuance (~1/min), so the token is cached in Postgres.
export async function kisToken(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.from('kis_token').select('*').eq('id', 1).maybeSingle()
  if (error) throw new Error(`kis_token: ${error.message}`)
  if (data && new Date(data.expires_at).getTime() - Date.now() > 10 * 60_000) return data.access_token

  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET }),
  })
  if (!res.ok) throw new Error(`KIS token: HTTP ${res.status} ${await res.text()}`)
  const j = await res.json()
  const expires_at = new Date(Date.now() + Number(j.expires_in) * 1000).toISOString()
  const { error: upErr } = await supabase
    .from('kis_token')
    .upsert({ id: 1, access_token: j.access_token, expires_at })
  if (upErr) throw new Error(`kis_token: ${upErr.message}`)
  return j.access_token
}

export async function kisGet(token: string, path: string, trId: string, params: Record<string, string>) {
  const url = `${KIS_BASE}${path}?${new URLSearchParams(params)}`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: KIS_APP_KEY,
        appsecret: KIS_APP_SECRET,
        tr_id: trId,
        custtype: 'P',
      },
    })
    const body = await res.json().catch(() => null)
    if (res.ok && body?.rt_cd === '0') return body
    // EGW00201 = 초당 거래건수 초과: back off and retry
    if (body?.msg_cd === 'EGW00201' && attempt < 5) {
      await sleep(1000)
      continue
    }
    throw new Error(`KIS ${trId}: HTTP ${res.status} ${body?.msg_cd ?? ''} ${body?.msg1 ?? ''}`.trim())
  }
}

// KIS returns every number as a string
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/,/g, '').trim()
  if (s === '' || s === '-') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Regular session 09:00–15:30 KST: the fraction elapsed at `t` (0 before the open, 1 after the close)
export function sessionElapsed(t: Date): number {
  const kst = new Date(t.getTime() + 9 * 3600 * 1000)
  const min = kst.getUTCHours() * 60 + kst.getUTCMinutes() - 9 * 60
  return Math.min(1, Math.max(0, min / 390))
}
