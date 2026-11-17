// KIS (한국투자증권) Open API client shared by kis-ingest and mcp.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

const KIS_BASE = 'https://openapi.koreainvestment.com:9443'
const KIS_APP_KEY = Deno.env.get('KIS_APP_KEY')!
const KIS_APP_SECRET = Deno.env.get('KIS_APP_SECRET')!

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Access tokens last 24h and KIS limits issuance (~1/min), so the token is cached in Postgres (shared by every
// function) and, per function instance, in memory (saves the DB read on a warm instance).
export type StoredToken = { access_token: string; expires_at: string }

const MIN_LEFT_MS = 10 * 60_000 // a token this close to expiry is treated as expired
let memo: StoredToken | null = null

export function isUsable(t: StoredToken | null | undefined): t is StoredToken {
  return !!t && new Date(t.expires_at).getTime() - Date.now() > MIN_LEFT_MS
}

/**
 * The cached token, from memory or else Postgres; null if there is none or it's about to expire. Never calls KIS, so
 * it is safe to start before knowing whether a quote is needed.
 */
export async function storedKisToken(supabase: SupabaseClient): Promise<StoredToken | null> {
  if (isUsable(memo)) return memo
  const { data, error } = await supabase.from('kis_token').select('access_token, expires_at').eq('id', 1).maybeSingle()
  if (error) throw new Error(`kis_token: ${error.message}`)
  if (!isUsable(data)) return null
  memo = data
  return data
}

/** Drops the in-memory token, e.g. after KIS rejected it, so the next lookup reads Postgres again. */
export function forgetKisToken() {
  memo = null
}

/**
 * A usable token: `stored` (a storedKisToken() result started earlier) or a fresh lookup, else a newly issued one.
 */
export async function kisToken(supabase: SupabaseClient, stored?: Promise<StoredToken | null>): Promise<string> {
  const s = await (stored ?? storedKisToken(supabase))
  if (isUsable(s)) return s.access_token

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
  memo = { access_token: j.access_token, expires_at }
  return j.access_token
}

/** A failed KIS call, with KIS's message code (msg_cd) so callers can tell a rejected token from other errors. */
export class KisError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message)
  }
}

// KIS answers a bad token with EGW00121 (invalid) or EGW00123 (expired), or a plain 401
export function isTokenRejected(e: unknown): boolean {
  return e instanceof KisError && (e.status === 401 || e.code === 'EGW00121' || e.code === 'EGW00123')
}

export type KisGetOptions = {
  // Called with each rate-limit wait (a promise that resolves when the wait is over); the call waits on what it returns.
  // Lets a caller record the waits (mcp: a `kis_rate_limited` step) without this module knowing about timings.
  onRateLimited?: (wait: Promise<void>) => PromiseLike<void>
}

export async function kisGet(
  token: string,
  path: string,
  trId: string,
  params: Record<string, string>,
  opts: KisGetOptions = {},
) {
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
    // EGW00201 = 초당 거래건수 초과: back off and retry. The limit is per app key, shared with kis-ingest's bursts.
    if (body?.msg_cd === 'EGW00201' && attempt < 5) {
      const wait = sleep(1000)
      await (opts.onRateLimited ? opts.onRateLimited(wait) : wait)
      continue
    }
    throw new KisError(
      `KIS ${trId}: HTTP ${res.status} ${body?.msg_cd ?? ''} ${body?.msg1 ?? ''}`.trim(),
      res.status,
      body?.msg_cd ?? null,
    )
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
