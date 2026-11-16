// Unit tests for region forwarding decisions (forward.ts).
// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1'
import { FORWARDED_HEADER, forwardHeaders, forwardUrl, responseHeaders, shouldForward } from './forward.ts'

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
  )
  assertEquals(h.get('authorization'), 'Bearer t')
  assertEquals(h.get('user-agent'), 'Claude-User') // usage logging still sees the real client
  assertEquals(h.get('mcp-protocol-version'), '2025-06-18')
  assertEquals(h.get('x-region'), 'ap-south-1')
  assertEquals(h.get(FORWARDED_HEADER), '1')
  assertEquals([h.has('host'), h.has('content-length')], [false, false])
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
