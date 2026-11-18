// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1'
import { readableError } from './errors.ts'

// The start of the page Cloudflare returned for an upsert on 2026-11-18 (telegram-ingest, insidertracking)
const CLOUDFLARE_520 = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<!--[if gt IE 8]><!--> <html class="no-js" lang="en-US"> <!--<![endif]-->
<head>
<title>supabase.co | 520: Web server is returning an unknown error</title>
<meta charset="UTF-8" />
</head>
<body><div id="cf-wrapper">…</div></body></html>`

Deno.test('readableError: an HTML error page becomes its title, after the message prefix', () => {
  assertEquals(
    readableError(`update posts: ${CLOUDFLARE_520}`),
    'update posts: HTML error page (supabase.co | 520: Web server is returning an unknown error)',
  )
})

Deno.test('readableError: a page cut off before its title, and one without a prefix', () => {
  assertEquals(readableError('save posts: <!DOCTYPE html>\n<!--[if lt IE 7]> <html cla'), 'save posts: HTML error page (no title)')
  assertEquals(readableError('<html><title>502 Bad\n  Gateway</title></html>'), 'HTML error page (502 Bad Gateway)')
})

Deno.test('readableError: URLs lose their query string, so the cause after them survives', () => {
  const codes = Array.from({ length: 30 }, (_, i) => `FID_COND_MRKT_DIV_CODE_${i + 1}=J&FID_INPUT_ISCD_${i + 1}=0101${i}0`).join('&')
  assertEquals(
    readableError(`error sending request from 10.32.33.59:49000 for https://openapi.koreainvestment.com:9443/uapi/x/intstock-multprice?${codes} (openapi.koreainvestment.com:9443): client error (SendRequest): connection reset`),
    'error sending request from 10.32.33.59:49000 for https://openapi.koreainvestment.com:9443/uapi/x/intstock-multprice?… (openapi.koreainvestment.com:9443): client error (SendRequest): connection reset',
  )
  assertEquals(readableError('see https://t.me/s/channel for details'), 'see https://t.me/s/channel for details')
})

Deno.test('readableError: other messages are unchanged', () => {
  for (const m of ['KIS FHKST11300006: HTTP 500 EGW00201 초당 거래건수를 초과하였습니다', 'refused snapshot: 40% missing', '']) {
    assertEquals(readableError(m), m)
  }
  assertEquals(readableError('bad value <htmlish>'), 'bad value <htmlish>') // not "<html " or "<html>"
})
