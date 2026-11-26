// Splits a long Telegram post (a digest, a market wrap) into chunks of one item each, so a filtered feed can show only
// the parts about a stock or an event. Pure; telegram-ingest's gate step stores the chunks (telegram_chunks) with
// their own tags. Tested on 10 sampled long posts (log 2026-11-26): market wraps (one paragraph each), world-news
// digests (one bullet each), quant notes (one comment each), a numbered weekly (its sections).
//
// The post's structure only decides where to cut:
//   - a header line starts a section, and nothing merges across a section: lines starting with an emoji (not ending
//     in a full stop), 【, a short [label], a number marker (`1.`, `2) …`), or `*label:`
//   - a bullet is its own unit (•, ·, ▪, -, 💬, `a.`), with the lines right after it (no blank line between)
//   - prose paragraphs (split at blank lines and separator lines) under MIN characters join the next one
//   - nothing over CAP: cut at a line break, else at a sentence end or a space
// A header stays with the first chunk of its section, as part of the text; one heading nothing is left out. Dropped: empty items (특이사항 없음),
// signature lines (작성자:, a lone t.me/… or @handle or URL), and the link preview our parser appends ([site · title]).

export const CHUNK_POSTS_OVER = 1500 // posts longer than this are chunked (10% of posts, half of all text, 11-26)
const MIN = 200
const CAP = 800
const SMALL_SECTION = 80 // a section this short with no bullets (a subtitle) goes in front of the next one

const SEP = /^[━─=_~\-]{5,}$/u
const HEADER = /^(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?!.*[.。]$)|【|\[[^\]]{2,40}\]$|\d{1,2}[.)]$|\d{1,2}[.)]\s+\S.{0,40}$|\*[^*]{1,40}:)/u
const BULLET = /^(?:[•·▪◦‣\-–]|💬|[a-z][.)]\s)/u
const EMPTY = /^(?:[•·▪◦‣\-–]|💬)?\s*(?:특이사항\s*없음|없음|해당\s*없음|n\/?a)\.?$/iu
const FOOT = /^(?:작성자\s*:|t\.me\/\S+$|@\w+$|https?:\/\/\S+$)/u
const PREVIEW = /^\[[^\]]*·[^\]]*\]$/u

/** A unit over CAP, cut at line breaks, then at a sentence end or a space (never mid-word when avoidable). */
function hard(unit: string): string[] {
  if (unit.length <= CAP) return [unit]
  const lines: string[] = []
  let cur = ''
  for (const l of unit.split('\n')) {
    if (cur && cur.length + 1 + l.length > CAP) {
      lines.push(cur)
      cur = l
    } else cur = cur ? `${cur}\n${l}` : l
  }
  if (cur) lines.push(cur)
  const out: string[] = []
  for (let c of lines) {
    while (c.length > CAP) {
      const end = Math.max(c.lastIndexOf('. ', CAP), c.lastIndexOf('다. ', CAP))
      const cut = end > CAP / 2 ? end + 1 : (c.lastIndexOf(' ', CAP) > CAP / 2 ? c.lastIndexOf(' ', CAP) : CAP)
      out.push(c.slice(0, cut).trim())
      c = c.slice(cut).trim()
    }
    if (c) out.push(c)
  }
  return out
}

type Section = { head: string | null; units: string[] }

function sections(text: string): Section[] {
  const out: Section[] = []
  let cur: Section = { head: null, units: [] }
  let para: string[] = []
  const endPara = () => {
    if (para.length) cur.units.push(para.join('\n'))
    para = []
  }
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (PREVIEW.test(s)) break // the link preview and its description: not the post's own text
    if (FOOT.test(s) || EMPTY.test(s)) continue
    if (!s || SEP.test(s)) {
      endPara()
      continue
    }
    if (HEADER.test(s) && !BULLET.test(s)) {
      endPara()
      if (cur.head || cur.units.length) out.push(cur)
      cur = { head: s, units: [] }
      continue
    }
    if (BULLET.test(s)) {
      endPara()
      para = [s]
      continue
    }
    para.push(s)
  }
  endPara()
  if (cur.head || cur.units.length) out.push(cur)
  return out
}

/** The post's chunks, in order. Fewer than two means the post isn't worth chunking (the caller stores none). */
export function chunkPost(text: string): string[] {
  const out: string[] = []
  let lead: string[] = [] // headers (and subtitles) waiting for the next section's first chunk
  for (const sec of sections(text)) {
    if (sec.head) lead.push(sec.head)
    if (!sec.units.length) continue
    const units = sec.units.flatMap(hard)
    if (!units.some((u) => BULLET.test(u)) && units.join('\n').length < SMALL_SECTION) {
      lead.push(...units)
      continue
    }
    const merged: string[] = []
    let c = ''
    for (const u of units) {
      if (c && (BULLET.test(u) || BULLET.test(c) || c.length >= MIN || c.length + 2 + u.length > CAP)) {
        merged.push(c)
        c = u
      } else c = c ? `${c}\n\n${u}` : u
    }
    if (c) {
      const last = merged.at(-1)
      if (last && c.length < MIN && !BULLET.test(c) && !BULLET.test(last) && last.length + 2 + c.length <= CAP) {
        merged[merged.length - 1] = `${last}\n\n${c}`
      } else merged.push(c)
    }
    if (lead.length) {
      merged[0] = `${lead.join('\n')}\n${merged[0]}`
      lead = []
    }
    out.push(...merged)
  }
  return out // headers left in `lead` head nothing (their items were dropped): left out
}
