// Unit tests for KIS response parsing and the session clock.
// Run from the repo root: deno task test

import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0'
import {
  forgetKisToken,
  isTokenRejected,
  KisError,
  kisGet,
  kisToken,
  num,
  sessionElapsed,
  storedKisToken,
  type StoredToken,
} from './kis.ts'

Deno.test('num parses KIS number strings', () => {
  assertEquals(num('1,234'), 1234)
  assertEquals(num(' -3.5 '), -3.5)
  assertEquals(num(42), 42)
  assertEquals(num(''), null)
  assertEquals(num('-'), null)
  assertEquals(num('abc'), null)
  assertEquals(num(null), null)
  assertEquals(num(undefined), null)
})

// KST = UTC+9, so 09:00 KST is 00:00 UTC and 15:30 KST is 06:30 UTC
Deno.test('sessionElapsed over the 09:00–15:30 KST session', () => {
  assertEquals(sessionElapsed(new Date('2026-11-13T23:30:00Z')), 0) // 08:30 KST, before the open
  assertEquals(sessionElapsed(new Date('2026-11-13T00:00:00Z')), 0) // 09:00 open
  assertEquals(sessionElapsed(new Date('2026-11-13T03:15:00Z')), 0.5) // 12:15, halfway
  assertEquals(sessionElapsed(new Date('2026-11-13T06:30:00Z')), 1) // 15:30 close
  assertEquals(sessionElapsed(new Date('2026-11-13T10:00:00Z')), 1) // 19:00 KST, after close
})

// ---- Token cache: memory, then Postgres, then KIS ----

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()

/** A stand-in for the kis_token table: counts reads and records upserts. */
function fakeDb(row: StoredToken | null) {
  const db = { reads: 0, upserts: [] as unknown[], row }
  const client = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => (db.reads++, Promise.resolve({ data: db.row, error: null })) }) }),
      upsert: (r: unknown) => (db.upserts.push(r), Promise.resolve({ error: null })),
    }),
  } as unknown as SupabaseClient
  return { db, client }
}

Deno.test('storedKisToken: Postgres once, then memory', async () => {
  forgetKisToken()
  const { db, client } = fakeDb({ access_token: 'db-token', expires_at: inHours(5) })
  assertEquals((await storedKisToken(client))?.access_token, 'db-token')
  assertEquals((await storedKisToken(client))?.access_token, 'db-token')
  assertEquals(db.reads, 1)
  forgetKisToken() // e.g. after KIS rejected it: the next lookup reads Postgres again
  db.row = { access_token: 'replaced', expires_at: inHours(5) }
  assertEquals((await storedKisToken(client))?.access_token, 'replaced')
  assertEquals(db.reads, 2)
})

Deno.test('storedKisToken never returns a token about to expire, and never calls KIS', async () => {
  forgetKisToken()
  const realFetch = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('KIS must not be called'))
  try {
    const { client } = fakeDb({ access_token: 'old', expires_at: inHours(0.1) }) // 6 minutes left
    assertEquals(await storedKisToken(client), null)
    assertEquals(await storedKisToken(fakeDb(null).client), null)
  } finally {
    globalThis.fetch = realFetch
  }
})

Deno.test('kisToken issues only without a usable stored token, and remembers the new one', async () => {
  forgetKisToken()
  const realFetch = globalThis.fetch
  let issued = 0
  globalThis.fetch = () => (issued++, Promise.resolve(Response.json({ access_token: 'new-token', expires_in: 86400 })))
  try {
    const { db, client } = fakeDb({ access_token: 'old', expires_at: inHours(0.1) })
    // an early lookup's result is used instead of a second read
    assertEquals(await kisToken(client, storedKisToken(client)), 'new-token')
    assertEquals([issued, db.reads, db.upserts.length], [1, 1, 1])
    // now in memory: no read, no issue
    assertEquals(await kisToken(client), 'new-token')
    assertEquals([issued, db.reads], [1, 1])
  } finally {
    globalThis.fetch = realFetch
    forgetKisToken()
  }
})

Deno.test('isTokenRejected: only KIS token errors', () => {
  assert(isTokenRejected(new KisError('x', 500, 'EGW00123')))
  assert(isTokenRejected(new KisError('x', 500, 'EGW00121')))
  assert(isTokenRejected(new KisError('x', 401, null)))
  assert(!isTokenRejected(new KisError('x', 500, 'EGW00201'))) // rate limit
  assert(!isTokenRejected(new Error('network')))
})

Deno.test('kisGet: a network error is retried, and the final error names the cause, not the whole URL', async () => {
  const realFetch = globalThis.fetch
  const url = (input: unknown) => String(input instanceof Request ? input.url : input)
  const fail = (input: unknown) =>
    Promise.reject(new TypeError(`error sending request from 10.0.0.1:49000 for ${url(input)} (openapi.koreainvestment.com:9443): client error (SendRequest): connection closed before message completed`))
  try {
    // fails once, then answers
    let n = 0
    const retried: string[] = []
    globalThis.fetch = ((input: unknown) => (n++ === 0 ? fail(input) : Promise.resolve(Response.json({ rt_cd: '0', output: [] })))) as typeof fetch
    const body = await kisGet('token', '/path', 'TR', { FID_INPUT_ISCD_1: '005930' }, { onNetworkRetry: (e) => retried.push(e.message) })
    assertEquals([body.rt_cd, n, retried.length], ['0', 2, 1])

    // fails every time: 3 attempts, then a KisError with the cause and no query string
    n = 0
    globalThis.fetch = ((input: unknown) => (n++, fail(input))) as typeof fetch
    const err = await kisGet('token', '/path', 'TR', { FID_INPUT_ISCD_1: '005930' }).catch((e) => e)
    assert(err instanceof KisError)
    assertEquals(n, 3)
    assert(err.message.startsWith('KIS TR: no answer after 3 attempts: error sending request'), err.message)
    assert(err.message.includes('connection closed before message completed'), err.message)
    assert(!err.message.includes('FID_INPUT_ISCD_1'), err.message)
  } finally {
    globalThis.fetch = realFetch
  }
})

Deno.test('kisGet: a rate-limited request waits, reports the wait, and retries', async () => {
  const realFetch = globalThis.fetch
  const answers = [{ rt_cd: '1', msg_cd: 'EGW00201', msg1: '초당 거래건수를 초과하였습니다.' }, { rt_cd: '0', output: { stck_prpr: '1000' } }]
  let requests = 0
  globalThis.fetch = () => Promise.resolve(Response.json(answers[requests++]))
  try {
    const waits: number[] = []
    const body = await kisGet('token', '/path', 'TR', {}, {
      onRateLimited: async (wait) => {
        const t0 = performance.now()
        await wait
        waits.push(performance.now() - t0)
      },
    })
    assertEquals(body.output.stck_prpr, '1000')
    assertEquals(requests, 2)
    assertEquals(waits.length, 1)
    assert(waits[0] >= 900, `waited ${waits[0]} ms`)
  } finally {
    globalThis.fetch = realFetch
  }
})
