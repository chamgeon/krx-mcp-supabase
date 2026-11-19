// Unit tests for the gate's checks (gate.ts), on small synthetic lists, with the cases found in the 2026-11-19
// experiment (docs/log.md). The model call itself isn't tested here (it needs the API).
// Run from the repo root: deno task test

import { assertEquals, assertThrows } from 'jsr:@std/assert@1.0.19'
import { checker, type Company, coreName, outputSchema, parseSymbolFile } from './gate.ts'

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
  assertEquals(outputSchema([]).properties.events, { type: 'array', items: { type: 'string' }, maxItems: 0 })
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
