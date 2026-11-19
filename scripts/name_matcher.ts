// The name matcher that tagged Telegram posts with KR stocks before the gate (supabase/functions/_shared/gate.ts)
// replaced it in production (2026-11-19). Kept only for the gate experiment (scripts/tg_gate.ts), as the baseline its
// report compares the gate's tags with.
//
// Stock names are matched as plain substrings, longest first. Names shorter than 3 characters are skipped because they
// collide with ordinary words (e.g. 대상, 한국), and 6-digit codes are matched directly. Nicknames (삼전, 하닉) come from
// the gate's STOCK_ALIASES.

import { STOCK_ALIASES } from '../supabase/functions/_shared/gate.ts'

export type StockIndex = { names: [string, string][]; codes: Set<string> }

export function buildStockIndex(
  stocks: { isu_cd: string; isu_nm: string }[],
  aliases: [string, string][] = STOCK_ALIASES,
): StockIndex {
  const names: [string, string][] = []
  const codes = new Set<string>()
  for (const r of stocks) {
    codes.add(r.isu_cd)
    if ([...r.isu_nm].length < 3) continue
    names.push([r.isu_nm, r.isu_cd])
    // Group prefixes are often written with a space: SK 하이닉스, LG 에너지솔루션
    const m = r.isu_nm.match(/^([A-Z&]+)(\p{Script=Hangul}.*)$/u)
    if (m) names.push([`${m[1]} ${m[2]}`, r.isu_cd])
  }
  for (const [alias, code] of aliases) if (codes.has(code)) names.push([alias, code])
  names.sort((a, b) => b[0].length - a[0].length) // longest first, so 삼성전자우 is checked before 삼성전자
  return { names, codes }
}

// A name only counts as a whole word: not glued to letters before it, and followed by a space, punctuation, or a
// Korean particle. Otherwise 퀀텀스케이프 would tag 케이프, 하이브리드 하이브, and 아스트라제네카 아스트.
const LETTER = /[\p{L}\p{N}]/u
const PARTICLES = [
  '으로', '에서', '에게', '까지', '부터', '보다', '처럼', '대비', '주가', '이다', '였다',
  '은', '는', '이', '가', '을', '를', '의', '와', '과', '도', '에', '로', '만', '측', '향', '등', '및', '株', '랑',
  'ADR', 'GDR', // depositary receipts: SK하이닉스ADR is still SK하이닉스
]

function isWholeWord(text: string, start: number, end: number): boolean {
  const before = text[start - 1]
  if (before && LETTER.test(before)) return false
  const after = text.slice(end)
  if (!after || !LETTER.test(after[0])) return true
  return PARTICLES.some((p) => after.startsWith(p))
}

export function tagStocks(text: string, idx: StockIndex): string[] {
  const found = new Set<string>()
  let rest = text
  for (const [name, code] of idx.names) {
    let from = 0
    for (let i = rest.indexOf(name, from); i !== -1; i = rest.indexOf(name, from)) {
      from = i + name.length
      if (!isWholeWord(rest, i, from)) continue
      found.add(code)
      // a matched name consumes its text, so 삼성전자우 doesn't also tag 삼성전자
      rest = rest.slice(0, i) + ' '.repeat(name.length) + rest.slice(from)
    }
  }
  // Codes: 6 characters, mostly digits, but 96 listed stocks have a letter (0001A0, 00088K). Only listed codes count,
  // so a 6-letter word like NVIDIA never matches.
  for (const m of text.matchAll(/(?<![0-9A-Za-z])([0-9A-Z]{6})(?![0-9A-Za-z])/g)) if (idx.codes.has(m[1])) found.add(m[1])
  return [...found]
}
