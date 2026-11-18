// Run from the repo root: deno task test

import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import { isAllowed, parseAllowed } from './allow.ts'

const ID = '687ee4bc-396c-4f37-9c68-6778ebd91d2c'

Deno.test('parseAllowed: ids and emails, trimmed and lowercased; unset or blank is empty', () => {
  assertEquals([...parseAllowed(` ${ID.toUpperCase()} , Friend@Example.com,, `)], [ID, 'friend@example.com'])
  assertEquals(parseAllowed(undefined).size, 0)
  assertEquals(parseAllowed(' , ').size, 0)
})

Deno.test('isAllowed: by user id or by email, case-insensitive', () => {
  const allowed = parseAllowed(`${ID}, friend@example.com`)
  assert(isAllowed(allowed, ID, 'someone@else.com'))
  assert(isAllowed(allowed, 'another-id', 'FRIEND@example.com'))
  assert(!isAllowed(allowed, 'another-id', 'stranger@example.com'))
  assert(!isAllowed(allowed, 'another-id', undefined))
})

Deno.test('isAllowed: an empty list lets nobody in (fails closed)', () => {
  assert(!isAllowed(parseAllowed(''), ID, 'me@example.com'))
})
