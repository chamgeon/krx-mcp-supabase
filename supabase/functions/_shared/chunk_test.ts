// Tests for chunkPost on made-up posts in the layouts the collected channels use (real posts aren't committed).
// Run from the repo root: deno task test

import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import { chunkPost } from './chunk.ts'

const para = (topic: string, n = 260) => `${topic} ${'시장 해설 문장입니다. '.repeat(Math.ceil(n / 14))}`.slice(0, n)

Deno.test('market wrap: one paragraph per chunk, a header stays with its first paragraph', () => {
  const post = [
    '11/04 미 증시, 중간선거 불확실성 해소에 급등',
    para('미 증시는 급등', 300),
    '',
    '*변화요인: 선거, 반도체, 경제지표',
    para('선거 결과', 280),
    '',
    para('반도체 하락', 320),
    '',
    para('경제지표', 290),
  ].join('\n')
  const c = chunkPost(post)
  assertEquals(c.length, 4)
  assert(c[0].startsWith('11/04 미 증시') && c[0].includes('미 증시는 급등'))
  assert(c[1].startsWith('*변화요인:') && c[1].includes('선거 결과'))
  assert(c[2].startsWith('반도체 하락') && c[3].startsWith('경제지표'))
})

Deno.test('world-news digest: one bullet per chunk; regions never mix; empty items, signature, preview dropped', () => {
  const post = [
    '🌎 글로벌 뉴스 브리핑 - 2026년 11월 16일',
    '',
    '🇺🇸 아메리카',
    '',
    '• 미 의회는 반도체 수출통제 강화 입법을 가속화.',
    '',
    '• 재무장관은 추가 긴축에 반대한다는 입장을 밝혀.',
    '',
    '🌍 중동',
    '',
    '• 이란 외무장관은 오만을 방문할 예정.',
    '',
    '🌍 아프리카',
    '',
    '• 특이사항 없음.',
    '',
    '작성자: 미국 주식 인사이더',
    't.me/insidertracking',
    '[Telegram · 미국 주식 인사이더]',
    'channel description',
  ].join('\n')
  const c = chunkPost(post)
  assertEquals(c, [
    '🌎 글로벌 뉴스 브리핑 - 2026년 11월 16일\n🇺🇸 아메리카\n• 미 의회는 반도체 수출통제 강화 입법을 가속화.',
    '• 재무장관은 추가 긴축에 반대한다는 입장을 밝혀.',
    '🌍 중동\n• 이란 외무장관은 오만을 방문할 예정.', // 🌍 아프리카 heads only an empty item: left out
  ])
})

Deno.test('quant note: a comment keeps the line under it; section headers start the next chunk, never end one', () => {
  const post = [
    '📡 주간 퀀트 코멘트',
    '👍 상향 기여 상위',
    '💬 엔비디아 +1.1 — 기여 +534억불',
    '비율 기준 5주 중 최고.',
    '💬 엑슨모빌 +3.7 — 기여 +281억불',
    '브렌트 117불 최대 수혜.',
    '🥲 하향 기여 상위',
    '💬 알파벳 -0.47 — 기여 -183억불',
  ].join('\n')
  const c = chunkPost(post)
  assertEquals(c, [
    '📡 주간 퀀트 코멘트\n👍 상향 기여 상위\n💬 엔비디아 +1.1 — 기여 +534억불\n비율 기준 5주 중 최고.',
    '💬 엑슨모빌 +3.7 — 기여 +281억불\n브렌트 117불 최대 수혜.',
    '🥲 하향 기여 상위\n💬 알파벳 -0.47 — 기여 -183억불',
  ])
})

Deno.test('numbered weekly: number markers are sections; a. b. points are bullets', () => {
  const post = [
    '[11/16, Weekly, 전략]',
    'a. 금요일 미국 증시는 하락.',
    'b. 내성이 생긴 가운데 복원력이 관건.',
    '1.',
    para('지난 주 코스피는 상승', 250),
    '2.',
    para('매크로상으로는 FOMC 의사록', 250),
  ].join('\n')
  const c = chunkPost(post)
  assertEquals(c.length, 4)
  assert(c[0].startsWith('[11/16, Weekly, 전략]\na. 금요일'))
  assertEquals(c[1], 'b. 내성이 생긴 가운데 복원력이 관건.')
  assert(c[2].startsWith('1.\n지난 주 코스피') && c[3].startsWith('2.\n매크로상으로는'))
})

Deno.test('caps: small paragraphs merge up to 200+, nothing passes 800, long text is cut at a sentence', () => {
  const small = Array.from({ length: 6 }, (_, i) => `짧은 문단 ${i}입니다. 내용은 조금.`).join('\n\n')
  for (const c of chunkPost(small)) assert(c.length <= 800)
  assertEquals(chunkPost(small).length, 1) // all short: one chunk (the caller stores none for a single chunk)
  const long = '가나다라마바사 문장입니다. '.repeat(200) // one 3,000-character paragraph, no line breaks
  const c = chunkPost(long)
  assert(c.length >= 4 && c.every((x) => x.length <= 800), c.map((x) => x.length).join(','))
  assert(c.slice(0, -1).every((x) => x.endsWith('.')), 'cut at a sentence end')
  assertEquals(c.join(' ').replace(/\s+/g, ''), long.replace(/\s+/g, '')) // nothing lost
})

Deno.test('a short subtitle goes in front of the next section, not into a chunk of its own', () => {
  const post = ['🌎 브리핑', '오전 6시~오후 2시', '🇺🇸 아메리카', '• 첫 소식입니다.', '• 둘째 소식입니다.'].join('\n')
  assertEquals(chunkPost(post), ['🌎 브리핑\n오전 6시~오후 2시\n🇺🇸 아메리카\n• 첫 소식입니다.', '• 둘째 소식입니다.'])
})
