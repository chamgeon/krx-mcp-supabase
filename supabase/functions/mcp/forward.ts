// Region forwarding. Edge Functions run in the region nearest the caller (Claude's and ChatGPT's servers), while the
// database is in one region (DB_REGION). Every query would then cross continents, ~700 ms per round trip on real calls.
// So a request that lands elsewhere is passed once to this function's copy in DB_REGION (x-region header), which does
// the work next to the database and streams the answer back. Users keep the same URL; changing DB_REGION is a setting.
//
// Never loops: a copy forwards only when it isn't in DB_REGION (SB_REGION is set by Supabase), and never forwards a
// request that was already forwarded (the x-mcp-forwarded marker), even if Supabase didn't honor x-region.

export const FORWARDED_HEADER = 'x-mcp-forwarded'

// Measuring the hop: the landing copy stamps when and where the request landed; the copy that handles it computes
// forward_ms = arrival − landed_at (one way, on two hosts' NTP-synced clocks) and logs it with the tool call.
// FORWARD_MS_HEADER is set only by this function on arrival; a value sent by a caller is always dropped.
export const LANDED_AT_HEADER = 'x-mcp-landed-at'
export const LANDED_IN_HEADER = 'x-mcp-landed-in'
export const FORWARD_MS_HEADER = 'x-mcp-forward-ms'
const MAX_FORWARD_MS = 60_000 // anything outside ±this is a bad stamp or clock, not a hop

/** Forward when a target region is configured, this copy runs elsewhere, and the request wasn't forwarded already. */
export function shouldForward(dbRegion: string | undefined, hereRegion: string | undefined, headers: Headers): boolean {
  if (!dbRegion) return false // not configured: local stack, tests
  if (headers.has(FORWARDED_HEADER)) return false
  return hereRegion !== dbRegion
}

/** The same request against the public function URL: path below /mcp and the query string are kept. */
export function forwardUrl(publicMcpUrl: string, requestUrl: string): string {
  const u = new URL(requestUrl)
  const below = u.pathname.match(/\/mcp(\/.*)?$/)?.[1] ?? ''
  return `${publicMcpUrl}${below}${u.search}`
}

/**
 * Request headers for the forwarded call: everything the caller sent (auth, User-Agent, MCP headers), plus the pin,
 * and when (`landedAt`, ms since epoch) and where the request landed.
 */
export function forwardHeaders(headers: Headers, dbRegion: string, landedIn: string | undefined, landedAt: number): Headers {
  const h = new Headers(headers)
  h.delete('host')
  h.delete('content-length') // recomputed from the body
  h.set('x-region', dbRegion)
  h.set(FORWARDED_HEADER, '1')
  h.set(LANDED_AT_HEADER, String(landedAt))
  if (landedIn) h.set(LANDED_IN_HEADER, landedIn)
  else h.delete(LANDED_IN_HEADER)
  return h
}

/**
 * Headers for handling a request that arrived at `arrivedAt`: for a forwarded request, FORWARD_MS_HEADER = the one-way
 * time from the landing copy; otherwise the hop headers are removed, so a caller can't put values in the log.
 */
export function arrivalHeaders(headers: Headers, arrivedAt: number): Headers {
  const h = new Headers(headers)
  h.delete(FORWARD_MS_HEADER)
  const landedAt = Number(h.get(LANDED_AT_HEADER))
  const ms = arrivedAt - landedAt
  if (h.has(FORWARDED_HEADER) && h.get(LANDED_AT_HEADER) && Number.isFinite(ms) && Math.abs(ms) <= MAX_FORWARD_MS) {
    h.set(FORWARD_MS_HEADER, String(Math.round(ms)))
    const landedIn = h.get(LANDED_IN_HEADER)
    if (landedIn) h.set(LANDED_IN_HEADER, landedIn.slice(0, 40))
  } else {
    h.delete(LANDED_AT_HEADER)
    h.delete(LANDED_IN_HEADER)
  }
  return h
}

/** What the log records about the hop, read from headers that went through arrivalHeaders */
export type Hop = { landedIn: string | null; forwardMs: number | null }

export function hopFrom(headers: Headers | undefined): Hop {
  const fwd = headers?.get(FORWARD_MS_HEADER)
  return { landedIn: headers?.get(LANDED_IN_HEADER) ?? null, forwardMs: fwd ? Number(fwd) : null }
}

/**
 * Response headers to pass back. fetch() already decoded the body, so the encoding and length headers no longer
 * describe it: passing them on would make clients decode twice or cut the stream short.
 */
export function responseHeaders(headers: Headers, handledIn: string | null): Headers {
  const h = new Headers(headers)
  for (const k of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) h.delete(k)
  if (handledIn) h.set('x-mcp-handled-in', handledIn)
  return h
}
