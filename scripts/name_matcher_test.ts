// Tests for the experiment's name matcher (name_matcher.ts), moved from supabase/functions/_shared/telegram_test.ts
// when the gate replaced it in production. Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { parsePage } from '../supabase/functions/_shared/telegram.ts'
import { buildStockIndex, tagStocks } from './name_matcher.ts'

// ---- tagging --------------------------------------------------------------------------------------

const idx = buildStockIndex([
  { isu_cd: '005930', isu_nm: '삼성전자' },
  { isu_cd: '005935', isu_nm: '삼성전자우' },
  { isu_cd: '000660', isu_nm: 'SK하이닉스' },
  { isu_cd: '373220', isu_nm: 'LG에너지솔루션' },
  { isu_cd: '352820', isu_nm: '하이브' },
  { isu_cd: '001680', isu_nm: '대상' }, // 2 characters: never matched by name
  { isu_cd: '123456', isu_nm: '케이프' },
  { isu_cd: '0001A0', isu_nm: '덕양에너젠' },
  { isu_cd: '00088K', isu_nm: '한화3우B' },
], [['삼전', '005930'], ['하닉', '000660'], ['하이닉스', '000660'], ['카뱅', '323410']]) // 카뱅's code isn't listed here

const tag = (text: string) => tagStocks(text, idx).sort()

Deno.test('tags names followed by particles, spaces and punctuation', () => {
  assertEquals(tag('삼성전자가 오늘 신고가'), ['005930'])
  assertEquals(tag('오늘은 삼성전자, 하이브 강세'), ['005930', '352820'])
  assertEquals(tag('(삼성전자)'), ['005930'])
})

Deno.test('longest name wins: 삼성전자우 does not also tag 삼성전자', () => {
  assertEquals(tag('삼성전자우 급등'), ['005935'])
  assertEquals(tag('삼성전자우와 삼성전자 모두'), ['005930', '005935'])
})

Deno.test('names inside longer words are not tagged', () => {
  assertEquals(tag('퀀텀스케이프 상장'), [])
  assertEquals(tag('하이브리드 차량'), [])
})

Deno.test('group prefix with a space, and ADR/GDR suffixes', () => {
  assertEquals(tag('SK 하이닉스 HBM'), ['000660'])
  assertEquals(tag('SK하이닉스ADR 상장 검토'), ['000660'])
  assertEquals(tag('SK 하이닉스 ADR'), ['000660'])
  assertEquals(tag('LG 에너지솔루션'), ['373220'])
})

Deno.test('2-character names are skipped, but their codes still match', () => {
  assertEquals(tag('대상 기업들'), [])
  assertEquals(tag('001680 관련'), ['001680'])
})

Deno.test('6-digit codes: only known codes, only exactly 6 digits', () => {
  assertEquals(tag('005930 매수'), ['005930'])
  assertEquals(tag('999999 매수'), [])
  assertEquals(tag('10059301'), [])
})

Deno.test('codes with a letter: only listed ones, only as a whole token', () => {
  assertEquals(tag('0001A0 신규상장'), ['0001A0'])
  assertEquals(tag('(00088K)'), ['00088K'])
  assertEquals(tag('NVIDIA 2026Q3A 0001A01 X0001A0'), []) // not listed, or glued to more characters
})

Deno.test('aliases: whole words like names, short ones allowed, only for listed codes', () => {
  assertEquals(tag('삼전 하닉 동반 강세'), ['000660', '005930'])
  assertEquals(tag('삼전이 오르고 하이닉스는'), ['000660', '005930'])
  assertEquals(tag('SK하이닉스 HBM'), ['000660']) // the full name still wins, once
  assertEquals(tag('삼전자 매수'), []) // inside a longer word
  assertEquals(tag('카뱅 상승'), []) // its code isn't in this list
})


// The fixtures are gitignored (third-party data, public repo): fetch them with `deno task fixtures`. Without them this
// test is skipped, not failed.
const FX = new URL('../supabase/functions/', import.meta.url)
const REAL_FILES = [
  new URL('_shared/fixtures/tme_s_ehdwl.html', FX),
  new URL('krx-ingest/fixtures/stk_bydd_trd_20261113.json', FX),
  new URL('krx-ingest/fixtures/ksq_bydd_trd_20261113.json', FX),
]
const HAVE_REAL = REAL_FILES.every((f) => {
  try {
    return Deno.statSync(f).isFile
  } catch {
    return false
  }
})
const realHtml = HAVE_REAL ? Deno.readTextFileSync(REAL_FILES[0]) : ''
const realIdx = buildStockIndex(
  (HAVE_REAL ? REAL_FILES.slice(1) : []).flatMap((f) => JSON.parse(Deno.readTextFileSync(f)).OutBlock_1)
    .map((r: Record<string, string>) => ({ isu_cd: r.ISU_CD, isu_nm: r.ISU_NM })),
)
const realPageTest = (name: string, fn: () => void) => Deno.test({ name, ignore: !HAVE_REAL, fn })

// Pins today's tagging of real posts. If a rule change alters it, review the diff: a new tag should be a real mention,
// a lost one should have been a false match.
realPageTest('real page: stock tags', () => {
  const tags = Object.fromEntries(
    parsePage(realHtml, 'ehdwl').posts
      .map((p): [number, string[]] => [p.msg_id, tagStocks(p.text, realIdx).sort()])
      .filter(([, t]) => t.length),
  )
  assertEquals(tags, {
    11289: ['000660'],
    11293: ['000660'],
    11295: ['000660', '005930'], // SK하이닉스 ADR, 삼성전자 GDR
    11298: ['000660'],
    11300: ['000660'],
    11304: ['000660', '005930'],
  })
})
