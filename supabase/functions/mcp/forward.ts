// Region forwarding. Edge Functions run in the region nearest the caller (Claude's and ChatGPT's servers), while the
// database is in one region (DB_REGION). Every query would then cross continents, ~700 ms per round trip on real calls.
// So a request that lands elsewhere is passed once to this function's copy in DB_REGION (x-region header), which does
// the work next to the database and streams the answer back. Users keep the same URL; changing DB_REGION is a setting.
//
// Never loops: a copy forwards only when it isn't in DB_REGION (SB_REGION is set by Supabase), and never forwards a
// request that was already forwarded (the x-mcp-forwarded marker), even if Supabase didn't honor x-region.

export const FORWARDED_HEADER = 'x-mcp-forwarded'

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

/** Request headers for the forwarded call: everything the caller sent (auth, User-Agent, MCP headers), plus the pin. */
export function forwardHeaders(headers: Headers, dbRegion: string): Headers {
  const h = new Headers(headers)
  h.delete('host')
  h.delete('content-length') // recomputed from the body
  h.set('x-region', dbRegion)
  h.set(FORWARDED_HEADER, '1')
  return h
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
