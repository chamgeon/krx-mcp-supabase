// Unit tests for region forwarding decisions (forward.ts).
// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1.0.19'
import {
  arrivalHeaders,
  CLIENT_HEADER,
  clientOf,
  hopFrom,
  needsDbRegion,
  FORWARD_MS_HEADER,
  FORWARDED_HEADER,
  forwardHeaders,
  forwardUrl,
  LANDED_AT_HEADER,
  LANDED_IN_HEADER,
  responseHeaders,
  shouldForward,
} from './forward.ts'

const none = new Headers()
const forwarded = new Headers({ [FORWARDED_HEADER]: '1' })

Deno.test('forwards only from another region, once', () => {
  assertEquals(shouldForward('ap-south-1', 'us-east-1', none), true) // Claude's call landed in the US
  assertEquals(shouldForward('ap-south-1', 'ap-south-1', none), false) // already next to the database
  assertEquals(shouldForward('ap-south-1', 'us-east-1', forwarded), false) // forwarded but landed elsewhere: handle it
  assertEquals(shouldForward(undefined, 'us-east-1', none), false) // not configured
  assertEquals(shouldForward('', 'us-east-1', none), false)
  assertEquals(shouldForward('ap-south-1', undefined, none), true) // region unknown: treat as elsewhere
})

Deno.test('target URL keeps the path below /mcp and the query', () => {
  const pub = 'https://ref.supabase.co/functions/v1/mcp'
  assertEquals(forwardUrl(pub, 'http://internal:9000/mcp'), pub)
  assertEquals(forwardUrl(pub, 'http://internal:9000/mcp?key=k'), `${pub}?key=k`)
  assertEquals(forwardUrl(pub, 'https://ref.supabase.co/functions/v1/mcp/sub/path?a=1&b=2'), `${pub}/sub/path?a=1&b=2`)
})

Deno.test('request headers: caller headers kept, pin and marker added, host dropped', () => {
  const h = forwardHeaders(
    new Headers({ authorization: 'Bearer t', 'user-agent': 'Claude-User', host: 'x', 'mcp-protocol-version': '2025-06-18', 'content-length': '10' }),
    'ap-south-1',
    'us-east-1',
    1_000_000,
  )
  assertEquals(h.get('authorization'), 'Bearer t')
  assertEquals(h.get('user-agent'), 'Claude-User') // usage logging still sees the real client
  assertEquals(h.get('mcp-protocol-version'), '2025-06-18')
  assertEquals(h.get('x-region'), 'ap-south-1')
  assertEquals(h.get(FORWARDED_HEADER), '1')
  assertEquals([h.has('host'), h.has('content-length')], [false, false])
  assertEquals([h.get(LANDED_AT_HEADER), h.get(LANDED_IN_HEADER)], ['1000000', 'us-east-1'])
})

Deno.test('response headers: decoded-body headers dropped, region noted', () => {
  const h = responseHeaders(
    new Headers({ 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': '5', 'www-authenticate': 'Bearer x' }),
    'ap-south-1',
  )
  assertEquals(h.get('content-type'), 'text/event-stream')
  assertEquals(h.get('www-authenticate'), 'Bearer x') // 401s still point clients to the login metadata
  assertEquals([h.has('content-encoding'), h.has('content-length')], [false, false])
  assertEquals(h.get('x-mcp-handled-in'), 'ap-south-1')
})

// ---- Hop timing: forwardHeaders stamps, arrivalHeaders measures ----

Deno.test('arrival: a forwarded request gets forward_ms and keeps where it landed', () => {
  const sent = forwardHeaders(new Headers(), 'ap-south-1', 'us-east-1', 1_000_000)
  const h = arrivalHeaders(sent, 1_000_180)
  assertEquals([h.get(FORWARD_MS_HEADER), h.get(LANDED_IN_HEADER)], ['180', 'us-east-1'])
  // a small negative value is clock skew between the hosts: kept, so it shows in the log
  assertEquals(arrivalHeaders(sent, 999_995).get(FORWARD_MS_HEADER), '-5')
})

Deno.test('arrival: caller-sent hop headers never reach the log', () => {
  // not forwarded: everything a caller sent is dropped
  const direct = arrivalHeaders(
    new Headers({ [FORWARD_MS_HEADER]: '1', [LANDED_AT_HEADER]: '999000', [LANDED_IN_HEADER]: 'fake' }),
    1_000_000,
  )
  assertEquals([direct.has(FORWARD_MS_HEADER), direct.has(LANDED_AT_HEADER), direct.has(LANDED_IN_HEADER)], [false, false, false])
  // forwarded: a sent forward_ms is replaced by the measured one
  const forwarded = arrivalHeaders(new Headers({ [FORWARDED_HEADER]: '1', [LANDED_AT_HEADER]: '999900', [FORWARD_MS_HEADER]: '1' }), 1_000_000)
  assertEquals(forwarded.get(FORWARD_MS_HEADER), '100')
})

Deno.test('arrival: a missing or implausible stamp gives no forward_ms', () => {
  const at = (stamp: string | null) => {
    const h = new Headers({ [FORWARDED_HEADER]: '1', [LANDED_IN_HEADER]: 'us-east-1' })
    if (stamp !== null) h.set(LANDED_AT_HEADER, stamp)
    return arrivalHeaders(h, 1_000_000)
  }
  for (const stamp of [null, '', 'abc', '1', String(1_000_000 + 61_000)]) {
    const h = at(stamp)
    assertEquals([h.has(FORWARD_MS_HEADER), h.has(LANDED_IN_HEADER)], [false, false], `stamp ${stamp}`)
  }
})

Deno.test('hopFrom: what reaches the log', () => {
  const sent = forwardHeaders(new Headers(), 'ap-south-1', 'us-east-1', 1_000_000)
  assertEquals(hopFrom(arrivalHeaders(sent, 1_000_120)), { landedIn: 'us-east-1', forwardMs: 120 })
  assertEquals(hopFrom(arrivalHeaders(new Headers({ [FORWARD_MS_HEADER]: '5' }), 1_000_000)), { landedIn: null, forwardMs: null })
  assertEquals(hopFrom(undefined), { landedIn: null, forwardMs: null })
})

// ---- Which requests cross to the database region ----

const body = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v)).buffer as ArrayBuffer
const rpc = (method: string, id: number | null = 1) => ({ jsonrpc: '2.0', ...(id == null ? {} : { id }), method })

Deno.test('needsDbRegion: only tool calls (and unknown methods) are forwarded', () => {
  // a session's start and the tool list are answered where the request landed
  for (const m of ['initialize', 'tools/list', 'ping']) assertEquals(needsDbRegion(body(rpc(m))), false, m)
  assertEquals(needsDbRegion(body(rpc('notifications/initialized', null))), false)
  assertEquals(needsDbRegion(body(rpc('notifications/cancelled', null))), false)
  // anything that may run a tool, or a method this list doesn't know yet, goes next to the database
  assertEquals(needsDbRegion(body({ ...rpc('tools/call'), params: { name: 'get_daily_movers', arguments: {} } })), true)
  assertEquals(needsDbRegion(body(rpc('resources/read'))), true)
})

Deno.test('needsDbRegion: a batch is forwarded if any message needs it', () => {
  assertEquals(needsDbRegion(body([rpc('initialize'), rpc('tools/list', 2)])), false)
  assertEquals(needsDbRegion(body([rpc('tools/list'), rpc('tools/call', 2)])), true)
})

Deno.test('needsDbRegion: no body or not JSON-RPC: answered locally (it cannot run a tool)', () => {
  assertEquals(needsDbRegion(undefined), false) // GET / DELETE
  assertEquals(needsDbRegion(new ArrayBuffer(0)), false)
  assertEquals(needsDbRegion(body('not json')), false)
  assertEquals(needsDbRegion(body('null')), false)
  assertEquals(needsDbRegion(body({ jsonrpc: '2.0', id: 1, result: {} })), false) // a response, not a call
  assertEquals(needsDbRegion(body({ method: 42 })), false)
})

// ---- The client (User-Agent) logged for a forwarded request ----

Deno.test('client: a forwarded request logs the User-Agent the landing copy saw', () => {
  const sent = forwardHeaders(new Headers({ 'user-agent': 'Claude-User' }), 'ap-south-1', 'us-east-1', 1_000_000)
  assertEquals(sent.get(CLIENT_HEADER), 'Claude-User')
  // the runtime appends its own to the forwarded request's User-Agent
  sent.set('user-agent', 'Claude-User (variant; SupabaseEdgeRuntime/1.79.1; ref=abc)')
  assertEquals(clientOf(arrivalHeaders(sent, 1_000_100)), 'Claude-User')
})

Deno.test('client: a direct request logs its own User-Agent; a caller-sent client header is dropped', () => {
  const direct = new Headers({ 'user-agent': 'openai-mcp/1.0.0', [CLIENT_HEADER]: 'fake' })
  assertEquals(clientOf(arrivalHeaders(direct, 1_000_000)), 'openai-mcp/1.0.0')
  assertEquals(clientOf(arrivalHeaders(new Headers(), 1_000_000)), null)
  assertEquals(clientOf(undefined), null)
})
