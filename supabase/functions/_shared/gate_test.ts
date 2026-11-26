// Unit tests for the gate's checks (gate.ts), on small synthetic lists, with the cases found in the 2026-11-19
// experiment (docs/log.md). The model call itself isn't tested here (it needs the API).
// Run from the repo root: deno task test

import { assertEquals, assertThrows } from 'jsr:@std/assert@1.0.19'
import type Anthropic from 'npm:@anthropic-ai/sdk@1.5.0'
import { askGate, checker, chunkTags, type Company, coreName, mentions, outputSchema, parseSymbolFile, systemPrompt, userMessage } from './gate.ts'

const stocks = [
  { isu_cd: '005930', isu_nm: '삼성전자' },
  { isu_cd: '000660', isu_nm: 'SK하이닉스' },
  { isu_cd: '005380', isu_nm: '현대차' },
  { isu_cd: '036570', isu_nm: 'NC' },
  { isu_cd: '039490', isu_nm: '키움증권' },
]
const symbols = [
  { ticker: 'NVDA', name: 'NVIDIA Corporation - Common Stock' },
  { ticker: 'MSFT', name: 'Microsoft Corporation - Common Stock' },
  { ticker: 'MS', name: 'Morgan Stanley Common Stock' },
  { ticker: 'AMD', name: 'Advanced Micro Devices, Inc. - Common Stock' },
  { ticker: 'GOOGL', name: 'Alphabet Inc. - Class A Common Stock' },
  { ticker: 'GOOG', name: 'Alphabet Inc. - Class C Capital Stock' },
  { ticker: 'RKLB', name: 'Rocket Lab Corporation - Common Stock' },
  { ticker: 'RBLX', name: 'Roblox Corporation Class A Common Stock' },
  { ticker: 'OWLT', name: 'Owlet, Inc. Class A Common Stock' },
  { ticker: 'AER', name: 'AerCap Holdings N.V. Ordinary Shares' },
  { ticker: 'KO', name: 'Coca-Cola Company (The) Common Stock' },
]
const check = checker(stocks, symbols)
const kr = (written: string, listed_name: string, id: string): Company => ({ written, listed_name, market: 'KR', id })
const us = (written: string, listed_name: string, id: string): Company => ({ written, listed_name, market: 'US', id })

Deno.test('coreName: legal and share-type words go, punctuation too', () => {
  assertEquals(coreName('Alphabet Inc. - Class A Common Stock'), 'alphabet')
  assertEquals(coreName('Coca-Cola Company (The) Common Stock'), 'cocacola')
  assertEquals(coreName('AerCap Holdings N.V. Ordinary Shares'), 'aercap')
  assertEquals(coreName('Johnson & Johnson'), 'johnsonjohnson')
})

Deno.test('KR: a code is kept when its KRX name matches the official or the written name', () => {
  assertEquals(check([kr('삼전', '삼성전자', '005930')]).kr, ['005930'])
  // the model's "official" name in English, the post has the KRX name plus ADR
  assertEquals(check([kr('SK하이닉스 ADR', 'SK hynix', '000660')]).kr, ['000660'])
  // a not-quite-official name (현대자동차), the written one is the KRX name
  assertEquals(check([kr('현대차', '현대자동차', '005380')]).kr, ['005380'])
  // a nickname decides the code (STOCK_ALIASES), even with the old name as the "official" one
  assertEquals(check([kr('엔씨소프트', '엔씨소프트', '036570')]).kr, ['036570'])
})

Deno.test("KR: a listed code that names another company is rejected, or corrected by the name", () => {
  const r = check([kr('하나증권', '하나증권', '039490')]) // 하나증권 isn't listed; 039490 is 키움증권
  assertEquals([r.kr, r.rejected.map((x) => x.why)], [[], ['code is 키움증권']])
  assertEquals(check([kr('삼성전자', '삼성전자', '000660')]).kr, ['005930']) // wrong code, right name
  assertEquals(check([kr('없는회사', '없는회사', '999999')]).rejected[0].why, 'no such code or name')
})

Deno.test('US: the ticker must be listed under the English name', () => {
  assertEquals(check([us('엔비디아', 'NVIDIA', 'NVDA'), us('AMD', 'AMD', 'AMD'), us('구글', 'Google', 'GOOGL')]).us, ['AMD', 'GOOGL', 'NVDA'])
  // "MS" written for Microsoft: corrected by name, not taken as Morgan Stanley's ticker
  const ms = check([us('MS', 'Microsoft', 'MS')])
  assertEquals([ms.us, ms.usByName.length], [['MSFT'], 1])
  assertEquals(check([us('모건스탠리', 'Morgan Stanley', 'MS')]).us, ['MS'])
  // a wrong ticker for the name: corrected (록랩 read as Rocket Lab, ticker RBLX)
  assertEquals(check([us('록랩', 'Rocket Lab', 'RBLX')]).us, ['RKLB'])
  // no ticker: found by English name; share classes prefer common stock (GOOGL over GOOG)
  assertEquals(check([us('Coca-Cola', 'Coca-Cola', ''), us('AerCap', 'AerCap Holdings', ''), us('Alphabet', 'Alphabet', '')]).us, ['AER', 'GOOGL', 'KO'])
})

Deno.test('US: a pairing the name contradicts, an unlisted company, a Korean-only name: rejected', () => {
  const r = check([
    us('아울렛', 'Outlet', 'OWLT'), // "outlet" read as Owlet's ticker
    us('앤트로픽', 'Anthropic', 'ANT'), // not listed (yet)
    us('모건스탠리', '', 'MS'), // no English name: can't be checked
  ])
  assertEquals(r.us, [])
  assertEquals(r.rejected.map((x) => x.why), ['listed as Owlet, Inc. Class A Common Stock', 'not a US-listed ticker', 'listed as Morgan Stanley Common Stock'])
})

Deno.test('the output schema only allows the listed events', () => {
  assertEquals(outputSchema([{ id: 'anthropic-ipo', description: 'x' }]).properties.events, {
    type: 'array', items: { type: 'string', enum: ['anthropic-ipo'] },
  })
  // No events (a post older than every event window): no events field, rather than an empty-array constraint
  const none = outputSchema([])
  assertEquals('events' in none.properties, false)
  assertEquals(none.required, ['label', 'companies'])
})

Deno.test('the output schema uses only keywords structured outputs accept', () => {
  // Rejected with a 400 ("For 'array' type, property 'maxItems' is not supported"), log 2026-11-20
  const unsupported = ['maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'pattern']
  const walk = (v: unknown, path: string): string[] =>
    v && typeof v === 'object'
      ? Object.entries(v).flatMap(([k, x]) => [...(unsupported.includes(k) ? [`${path}.${k}`] : []), ...walk(x, `${path}.${k}`)])
      : []
  for (const events of [[], [{ id: 'anthropic-ipo', description: 'x' }]]) {
    for (const chunked of [false, true]) {
      assertEquals(walk(outputSchema(events, chunked), 'schema'), [], `${events.length} events, chunked ${chunked}`)
    }
  }
})

// ---- chunked posts (v6) ---------------------------------------------------------------------------

const EV = [{ id: 'anthropic-ipo', description: 'Anthropic IPO' }]
const post = { username: 'ch', ts: '2026-11-18T00:00:00Z', text: 'whole text', has_media: false, forwarded_from: null }

Deno.test('chunked: parts are numbered in the message; chunk_events only with events; v5 prompt otherwise', () => {
  const msg = userMessage({ ...post, chunks: ['엔비디아 실적', '앤트로픽 상장'] })
  assertEquals(msg.split('<post>\n')[1], '[1]\n엔비디아 실적\n\n[2]\n앤트로픽 상장\n</post>')
  assertEquals(userMessage(post).includes('whole text'), true)
  const schema = outputSchema(EV, true)
  assertEquals(schema.required, ['label', 'companies', 'events', 'chunk_events'])
  assertEquals('chunk_events' in outputSchema(EV, false).properties, false)
  assertEquals('chunk_events' in outputSchema([], true).properties, false) // no events to place: nothing to ask
  assertEquals(systemPrompt(EV, false), systemPrompt(EV)) // unchunked: v5's prompt exactly
  assertEquals(systemPrompt(EV, true).includes('numbered parts'), true)
  assertEquals(systemPrompt([], true), systemPrompt([]))
})

Deno.test('chunked: askGate reads chunk_events by part number; the post gets every event its parts name', async () => {
  const answer = {
    label: 'market',
    companies: [],
    events: [],
    chunk_events: [{ part: 2, events: ['anthropic-ipo', 'unknown-event'] }, { part: 9, events: ['anthropic-ipo'] }],
  }
  const client = {
    messages: {
      create: () => Promise.resolve({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 1, output_tokens: 1 } }),
    },
  } as unknown as Anthropic
  const a = await askGate(client, { ...post, chunks: ['a', 'b', 'c'] }, EV)
  assertEquals(a.chunkEvents, [[], ['anthropic-ipo'], []]) // part 9 doesn't exist: ignored
  assertEquals(a.events, ['anthropic-ipo'])
  assertEquals((await askGate(client, post, EV)).chunkEvents, undefined)
})

Deno.test('chunkTags: a company goes to the chunks that contain its written name, checked like the post', () => {
  const chunks = ['엔비디아와 삼성 전자 동반 상승', 'SK하이닉스는 보합', '시장 전반 해설']
  const companies = [
    us('엔비디아', 'NVIDIA', 'NVDA'),
    kr('삼성전자', '삼성전자', '005930'), // written without the space the chunk has: spacing is ignored
    kr('SK하이닉스', 'SK하이닉스', '000660'),
    us('구글', 'Alphabet', 'GOOGL'), // named by the model but in no chunk: stays on the post only
  ]
  const tags = chunkTags(chunks, companies, check, [['anthropic-ipo'], [], []])
  assertEquals(tags, [
    { stock_codes: ['005930'], us_tickers: ['NVDA'], events: ['anthropic-ipo'] },
    { stock_codes: ['000660'], us_tickers: [], events: [] },
    { stock_codes: [], us_tickers: [], events: [] },
  ])
})

Deno.test('parseSymbolFile: both files, without ETFs and test issues', () => {
  const nasdaq = [
    'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
    'NVDA|NVIDIA Corporation - Common Stock|Q|N|N|100|N|N',
    'QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N',
    'ZZZT|Test Issue Corp|Q|Y|N|100|N|N',
    'File Creation Time: 1119202608:01|||||||',
  ].join('\n')
  assertEquals(parseSymbolFile('nasdaqlisted', nasdaq), [{ ticker: 'NVDA', name: 'NVIDIA Corporation - Common Stock', exchange: 'NASDAQ' }])
  const other = [
    'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
    'BRK.B|Berkshire Hathaway Inc. New Common Stock|N|BRK.B|N|100|N|BRK=B',
    'SPY|SPDR S&P 500|P|SPY|Y|100|N|SPY',
  ].join('\n')
  assertEquals(parseSymbolFile('otherlisted', other), [{ ticker: 'BRK.B', name: 'Berkshire Hathaway Inc. New Common Stock', exchange: 'NYSE' }])
  // a format change is an error, not an empty list
  assertThrows(() => parseSymbolFile('nasdaqlisted', 'Ticker|Name\nNVDA|NVIDIA'), Error, 'unexpected header')
})

Deno.test('mentions: a name is matched as a word of its own (found in a real v6 run, 11-26)', () => {
  assertEquals(mentions('소비자 구매력 개선', '비자'), false) // Visa read inside 소비자
  assertEquals(mentions('비자(+1.2%)는 강세', '비자'), true)
  assertEquals(mentions('AMS 장비와 MSCI 지수', 'MS'), false)
  assertEquals(mentions('MS(-2.83%)는 회사채 발행', 'MS'), true)
  assertEquals(mentions('AI 서버: 델 실적 호조. 델(+0.60%)', '델'), true) // one syllable: allowed now
  assertEquals(mentions('델은 매출이 늘었다', '델'), true) // a particle may follow
  assertEquals(mentions('델타항공은 하락', '델'), false)
  assertEquals(mentions('강세 갭(+11.44%)은', '갭'), true)
  assertEquals(mentions('엔비디아와 삼성 전자', '삼성전자'), true) // spacing ignored
  assertEquals(mentions('SK하이닉스의 실적', 'sk하이닉스'), true) // case ignored, a particle after a long name
})

Deno.test('OTHER: a company the model calls unlisted is tagged only by an exact listing name or an alias', () => {
  const withAnt = checker(stocks, [...symbols, { ticker: 'ANT', name: 'Anthropic PBC - Class A Common Stock' }])
  const other = (written: string, listed_name: string): Company => ({ written, listed_name, market: 'OTHER', id: '' })
  assertEquals(withAnt([other('앤트로픽', '앤트로픽')]).us, ['ANT']) // Korean alias
  assertEquals(withAnt([other('앤스로픽', 'Anthropic')]).us, ['ANT']) // English name, exact
  assertEquals(withAnt([other('오픈AI', 'OpenAI')]).us, []) // not listed
  assertEquals(withAnt([other('카카오', '카카오')]).us, [])
  assertEquals(check([other('앤트로픽', 'Anthropic')]).us, []) // no ANT in the list: nothing
})
