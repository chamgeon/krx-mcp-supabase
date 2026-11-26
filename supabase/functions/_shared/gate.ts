// The Telegram gate: one Claude Haiku call per post labels it (market / noise), names the companies it mentions
// (KR code or US ticker) and the events it's about. The model's codes and tickers are checked against the KRX stock
// list and the US symbol list before anything is stored. Used by telegram-ingest (production) and scripts/tg_gate.ts
// (the local experiment the prompt was tuned with, docs/log.md 2026-11-19), so the two can't drift apart.
// Columns: migration 20261119000000_telegram_gate.sql.

import type Anthropic from 'npm:@anthropic-ai/sdk@1.5.0'

export const GATE_MODEL = 'claude-haiku-5-5'
export const GATE_PRICE = { input: 0.10, output: 0.50 } // $ per million tokens (prompts under 100K tokens)
// Prompt versions (tuned on 741 posts, 2026-11-19): v1 first; v2 any news report is market, nicknames, US lookup by
// English name; v3 english_name and a US name check; v4 one name in the listing's language (the model often ignored
// the rule); v5 written (as in the post) + listed_name (official name on its exchange), posts in any language; v6 the
// same, but a long Telegram post comes in numbered parts (./chunk.ts) and the answer says which parts are about which
// events (chunk_events); a post that isn't chunked gets v5's prompt exactly. telegram_messages.gate_version records it.
export const GATE_VERSION = 'v6'

export type GatePost = {
  username: string
  msg_id: number
  ts: string
  text: string
  has_media: boolean
  forwarded_from: string | null
}
// What the gate reads of a post (Telegram's or X's: the source's own key isn't part of it). With `chunks`, the post
// is shown as those numbered parts instead of `text` (a long Telegram post, ./chunk.ts).
export type GateInput = Omit<GatePost, 'msg_id'> & { chunks?: string[] }
export type GateEvent = { id: string; description: string }
export type Stock = { isu_cd: string; isu_nm: string }
export type UsSymbol = { ticker: string; name: string; exchange?: string }

// v5: written + listed_name. Runs of earlier prompts (scripts/tg_gate.ts recheck) have name, and v3 english_name
export type Company = {
  written?: string
  listed_name?: string
  name?: string
  english_name?: string
  market: 'KR' | 'US' | 'OTHER'
  id: string
}
export type Checked = { kr: string[]; us: string[]; usByName: string[]; rejected: (Company & { why: string })[] }

// The name to check against the listing, and the name as written, whichever prompt version produced the company
export const listedName = (c: Company) => (c.listed_name?.trim() || c.english_name?.trim() || c.name || '').trim()
export const writtenName = (c: Company) => (c.written ?? c.name ?? '').trim()

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').replace(/\(주\)|㈜/g, '').toUpperCase()
// US class shares: Nasdaq's files write BRK.B, posts and models also write BRK-B or BRK/B
export const normTicker = (s: string) => s.trim().toUpperCase().replace(/^\$/, '').replace(/[-/]/g, '.')

// Nicknames for a few large caps, chosen by hand: the KR check accepts them as names of their stock (삼전 → 005930).
// Checked against the stock list (2026-11-18); an alias whose code isn't listed is ignored. Left out on purpose: 포스코
// (several POSCO companies). After changing it, re-gate (gated_at = null). scripts/name_matcher.ts uses it too.
export const STOCK_ALIASES: [alias: string, code: string][] = [
  ['삼전', '005930'], // 삼성전자
  ['하닉', '000660'], // SK하이닉스
  ['하이닉스', '000660'],
  ['엘엔솔', '373220'], // LG에너지솔루션
  ['엘지엔솔', '373220'],
  ['LG엔솔', '373220'],
  ['현차', '005380'], // 현대차
  ['기아차', '000270'], // 기아 (its name until 2021)
  ['삼바', '207940'], // 삼성바이오로직스
  ['셀트', '068270'], // 셀트리온
  ['카뱅', '323410'], // 카카오뱅크
  ['한화에어로', '012450'], // 한화에어로스페이스
  ['에코비엠', '247540'], // 에코프로비엠
  ['두산에너빌', '034020'], // 두산에너빌리티
  ['네이버', '035420'], // NAVER
  ['엔씨소프트', '036570'], // NC (its name until the rename; "NC" itself is too short to match)
]

// A US company's name reduced to its core for lookup: "Alphabet Inc. - Class A Common Stock" and "Alphabet" → "alphabet",
// "The Coca-Cola Company" → "cocacola". Only Latin-script names: the symbol list has no Korean names.
const LEGAL = /\b(the|inc|incorporated|corp|corporation|co|company|companies|ltd|limited|plc|holdings?|group|sa|nv|ag|se|lp|llc)\b/g
// The security type, which nasdaqlisted.txt puts after " - " and otherlisted.txt doesn't
const SECURITY =
  /\b(class [a-z]|common stock|capital stock|ordinary shares?|american depositary (shares?|receipts?)|depositary shares?|units?|warrants?|rights?|preferred|subordinate voting shares)\b.*$/
export const coreName = (s: string) =>
  s.split(' - ')[0].toLowerCase().replace(SECURITY, ' ').replace(/\./g, '').replace(/&/g, ' ').replace(/[,'’()]/g, ' ')
    .replace(LEGAL, ' ').replace(/[^a-z0-9]/g, '')

// Common names that differ from the listed (legal) name, checked by hand against Nasdaq's symbol file (2026-11-19).
// Only unambiguous ones: a brand that is one listed company, or a former name. Matched on the core name (coreName).
// Left out on purpose: "MS" (Microsoft in Korean posts, Morgan Stanley's ticker) and subsidiaries (YouTube, Waymo).
// An alias whose ticker isn't listed is ignored. After changing this list, re-gate (gated_at = null).
export const US_ALIASES: [alias: string, ticker: string][] = [
  ['Google', 'GOOGL'], // Alphabet
  ['Facebook', 'META'], // Meta Platforms
  ['BofA', 'BAC'], // Bank of America
  ['Citi', 'C'], // Citigroup
  ['Citibank', 'C'],
  ['TSMC', 'TSM'], // Taiwan Semiconductor Manufacturing
  ['Iris Energy', 'IREN'], // renamed IREN
  ['II-VI', 'COHR'], // renamed Coherent
  ['Riot Blockchain', 'RIOT'], // renamed Riot Platforms
  ['Square', 'XYZ'], // renamed Block
  ['Berkshire Hathaway', 'BRK.B'], // two classes; B is the one usually quoted
  ['HP Enterprise', 'HPE'], // Hewlett Packard Enterprise
  // Listed after the model's knowledge (it calls them unlisted: OTHER), so their names are aliases too
  ['Anthropic', 'ANT'], // Nasdaq, 2026-11-19
  ['앤트로픽', 'ANT'],
  ['앤스로픽', 'ANT'],
]

/**
 * Checks the model's companies against the KRX stock list and the US symbol list; returns the codes and tickers
 * that pass, and the rejected guesses with the reason.
 *
 * KR: the code must exist and its KRX name match the official name the model gives or the name as written (either
 * containing the other: a post shortens a name, or adds ADR); else a hand-picked nickname (STOCK_ALIASES: 삼전, 하닉) or
 * an exact KRX name decides the code; else rejected.
 *
 * US: the ticker must be listed and its listed name match the company's English (listed) name: the same core name,
 * one containing the other (3+ characters), the ticker itself as the name (AMD), or a reviewed alias (US_ALIASES).
 * Else the name is looked up (alias, then core name), which can also correct a wrong ticker (MS written for
 * Microsoft → MSFT); else rejected. A name only in Korean can't be checked, so it's rejected.
 *
 * OTHER (the model says unlisted): tagged only when its name is exactly a US listing's (core name) or an alias
 * (US_ALIASES, Korean ones included): a company listed after the model's knowledge (Anthropic, 2026-11-19).
 */
export function checker(stocks: Stock[], symbols: UsSymbol[]) {
  const byCode = new Map(stocks.map((s) => [s.isu_cd, s]))
  const byName = new Map(stocks.map((s) => [norm(s.isu_nm), s.isu_cd]))
  const aliases = new Map(STOCK_ALIASES.filter(([, c]) => byCode.has(c)).map(([a, c]) => [norm(a), c]))
  const usName = new Map(symbols.map((s) => [normTicker(s.ticker), s.name]))
  const usAlias = new Map(US_ALIASES.filter(([a, t]) => usName.has(t) && coreName(a).length > 0).map(([a, t]) => [coreName(a), t]))
  // aliases written in another script (앤트로픽): matched on the normalized name, for OTHER companies
  const usAliasOther = new Map(US_ALIASES.filter(([a, t]) => usName.has(t) && !coreName(a).length).map(([a, t]) => [norm(a), t]))
  // core name → ticker. Several share classes or listings can share a name (GOOGL/GOOG): prefer common stock or ADSs,
  // then the shortest ticker
  const rank = (s: UsSymbol) => (/common stock|ordinary shares|american depositary/i.test(s.name) ? 0 : 1) * 100 + s.ticker.length
  const usByCore = new Map<string, UsSymbol>()
  for (const s of symbols) {
    const k = coreName(s.name)
    if (k.length < 3) continue
    const cur = usByCore.get(k)
    if (!cur || rank(s) < rank(cur) || (rank(s) === rank(cur) && s.ticker < cur.ticker)) usByCore.set(k, s)
  }
  const same = (a: string, b: string) => a === b || a.includes(b) || b.includes(a)

  return (companies: Company[]): Checked => {
    const kr = new Set<string>(), us = new Set<string>(), usByName = new Set<string>(), rejected: Checked['rejected'] = []
    for (const c of companies) {
      if (c.market === 'KR') {
        const hit = byCode.get(c.id.trim().toUpperCase())
        const ns = [...new Set([listedName(c), writtenName(c)].map(norm).filter(Boolean))]
        const named = ns.map((n) => aliases.get(n) ?? byName.get(n)).find(Boolean)
        if (hit && ns.some((n) => same(norm(hit.isu_nm), n))) kr.add(hit.isu_cd)
        else if (named) kr.add(named)
        else rejected.push({ ...c, why: hit ? `code is ${hit.isu_nm}` : 'no such code or name' })
      } else if (c.market === 'US') {
        const t = normTicker(c.id)
        const names = [listedName(c)].filter((n) => /[a-z]/i.test(n))
        const cores = names.map(coreName).filter((k) => k.length > 0)
        const listed = usName.get(t)
        const matches = (ticker: string, listedAs: string) => {
          const l = coreName(listedAs)
          return names.some((n) => normTicker(n) === ticker) ||
            cores.some((k) => k === l || (k.length >= 3 && (l.includes(k) || k.includes(l))) || usAlias.get(k) === ticker)
        }
        const found = cores.map((k) => usAlias.get(k) ?? (usByCore.get(k) && normTicker(usByCore.get(k)!.ticker))).find(Boolean)
        if (listed && matches(t, listed)) us.add(t)
        else if (found) {
          us.add(found)
          usByName.add(`${names[0]} → ${found}${listed ? ` (model said ${t}: ${listed})` : ''}`)
        } else {
          rejected.push({ ...c, why: listed ? `listed as ${listed}` : t ? 'not a US-listed ticker' : 'no ticker, name not in the symbol list' })
        }
      } else if (c.market === 'OTHER') {
        const found = [listedName(c), writtenName(c)].map((n) => {
          const k = coreName(n)
          return (k.length >= 3 && (usAlias.get(k) ?? (usByCore.get(k) && normTicker(usByCore.get(k)!.ticker)))) ||
            usAliasOther.get(norm(n))
        }).find(Boolean)
        if (found) {
          us.add(found)
          usByName.add(`${listedName(c)} (said unlisted) → ${found}`)
        }
      }
    }
    return { kr: [...kr].sort(), us: [...us].sort(), usByName: [...usByName], rejected }
  }
}

/**
 * Each chunk's tags from the post's answer: a company goes to the chunks that mention its name as written (mentions),
 * checked like the post's; events come from the answer's chunk_events. A company
 * the model named in a form no chunk contains stays on the post only.
 */
// Whether `text` mentions `name` as a word of its own: the name starts a word (비자 isn't in 소비자, MS isn't in AMS),
// spaces inside it are optional (삼성 전자), case and (주) are ignored. A name of 1–2 characters must also end the word,
// though a Korean particle may follow (델은, 갭의; not 델타).
const WORDCHAR = String.raw`[\p{L}\p{N}]`
const PARTICLE = '[은는이가을를의도와과로에만]'
export function mentions(text: string, name: string): boolean {
  const n = name.normalize('NFKC').replace(/\(주\)|㈜/g, '').replace(/\s+/g, '')
  if (!n) return false
  const body = [...n].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')
  const end = [...n].length <= 2 ? `(?!${WORDCHAR})|(?=${PARTICLE}(?!${WORDCHAR}))` : ''
  return new RegExp(`(?<!${WORDCHAR})${body}(?:${end || '(?:)'})`, 'iu').test(text.normalize('NFKC'))
}

export function chunkTags(
  chunks: string[],
  companies: Company[],
  check: (cs: Company[]) => Checked,
  chunkEvents: string[][] = [],
): { stock_codes: string[]; us_tickers: string[]; events: string[] }[] {
  return chunks.map((text, i) => {
    const named = companies.filter((c) => mentions(text, writtenName(c)))
    const c = check(named)
    return { stock_codes: c.kr, us_tickers: c.us, events: chunkEvents[i] ?? [] }
  })
}

// ---- the model call ---------------------------------------------------------------------------------

export function systemPrompt(events: GateEvent[], chunked = false): string {
  return `You label posts from stock-market Telegram channels. Posts can be in any language. Answer with the JSON the
schema asks for.

label:
- "noise" only when the post clearly carries no market information: personal chatter or greetings, channel
  housekeeping (announcing a format change, asking for subscriptions or shares), ads for the channel's own paid
  services, or filler with no content (e.g. "....", a lone word with no context).
- "market" for everything else. Any news report is market, whatever its subject (politics, diplomacy, accidents,
  protests, quotes from officials): the reader decides what matters to the market. Also market: one-line headlines,
  prices, index or futures levels, sentiment indicators, schedules, analyst notes, links to reports, opinions about
  stocks or the market. When unsure, use "market".

companies: every company the post mentions as a business or a stock. Not people, countries, indices, sectors or
commodities. One entry per company:
- written: the name exactly as it appears in the post.
- listed_name: the company's official name on its exchange, whatever language the post uses. For KR, its Korean name
  on the Korea Exchange (삼전 → 삼성전자, Samsung Electronics → 삼성전자, 하이닉스 → SK하이닉스). For US, its English name
  (엔비디아 → NVIDIA, 구글 → Alphabet, 마이크론 → Micron Technology). For OTHER, the same as written.
- market: "KR" if it is listed on the Korea Exchange (KOSPI or KOSDAQ), "US" if it is listed on a US exchange,
  "OTHER" if it is unlisted or listed only elsewhere.
- id: for KR the 6-character KRX code (e.g. 005930), for US the ticker (e.g. NVDA), for OTHER an empty string.
Leave a company out rather than guess its market. A company listed in both Korea and the US is KR.

events: the ids from this list that the post is about (none if it matches no event):
${events.length ? events.map((e) => `- ${e.id}: ${e.description}`).join('\n') : '(no events)'}${
    chunked && events.length
      ? `

The post comes in numbered parts. chunk_events: each part that is about one of the events, with those event ids
(leave out the parts about none). events still lists every event the whole post is about.`
      : ''
  }`
}

export function outputSchema(events: GateEvent[], chunked = false) {
  const ids = { type: 'string', enum: events.map((e) => e.id) }
  return {
    type: 'object',
    additionalProperties: false,
    // No events to choose from (a post older than every event window): no events field at all. Structured outputs
    // reject array constraints such as maxItems (log 2026-11-20); askGate reads a missing events as none.
    required: events.length ? ['label', 'companies', 'events', ...(chunked ? ['chunk_events'] : [])] : ['label', 'companies'],
    properties: {
      label: { type: 'string', enum: ['market', 'noise'] },
      companies: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['written', 'listed_name', 'market', 'id'],
          properties: {
            written: { type: 'string' },
            listed_name: { type: 'string' },
            market: { type: 'string', enum: ['KR', 'US', 'OTHER'] },
            id: { type: 'string' },
          },
        },
      },
      ...(events.length ? { events: { type: 'array', items: ids } } : {}),
      ...(events.length && chunked
        ? {
          chunk_events: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['part', 'events'],
              properties: { part: { type: 'integer' }, events: { type: 'array', items: ids } },
            },
          },
        }
        : {}),
    },
  }
}

export function userMessage(p: GateInput): string {
  const kst = new Date(new Date(p.ts).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
  return [
    `Channel: ${p.username}`,
    `Posted: ${kst} KST`,
    ...(p.forwarded_from ? [`Forwarded from: ${p.forwarded_from}`] : []),
    ...(p.has_media ? ['Has an image or video (not shown)'] : []),
    '',
    '<post>',
    p.chunks?.length ? p.chunks.map((c, i) => `[${i + 1}]\n${c}`).join('\n\n') : p.text,
    '</post>',
  ].join('\n')
}

export type GateAnswer = {
  label: 'market' | 'noise'
  reason: 'empty' | 'model' // empty: no text, labeled noise without a call
  companies: Company[]
  events: string[]
  chunkEvents?: string[][] // with chunks: the events of each part, in order (none = [])
  usage?: { input: number; output: number }
  ms?: number
}

/** One post through the gate. Throws on a failed call or an answer that isn't the schema's JSON. */
export async function askGate(
  client: Anthropic,
  post: GateInput,
  events: GateEvent[],
  opts: { thinking?: boolean } = {},
): Promise<GateAnswer> {
  if (!post.text.trim()) return { label: 'noise', reason: 'empty', companies: [], events: [] }
  const t0 = performance.now()
  const chunked = (post.chunks?.length ?? 0) > 1
  const format = { type: 'json_schema' as const, schema: outputSchema(events, chunked) }
  const res = await client.messages.create({
    model: GATE_MODEL,
    max_tokens: 8000, // long digests list dozens of companies
    system: systemPrompt(events, chunked),
    messages: [{ role: 'user', content: userMessage(post) }],
    ...(opts.thinking
      ? { output_config: { effort: 'low' as const, format } }
      : { thinking: { type: 'disabled' as const }, output_config: { format } }),
  })
  const ms = Math.round(performance.now() - t0)
  if (res.stop_reason !== 'end_turn') throw new Error(`stop_reason ${res.stop_reason}`)
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  const out = JSON.parse(text) as {
    label: 'market' | 'noise'
    companies: Company[]
    events: string[]
    chunk_events?: { part: number; events: string[] }[]
  }
  const known = new Set(events.map((e) => e.id))
  const chunkEvents = chunked ? post.chunks!.map(() => [] as string[]) : undefined
  for (const ce of out.chunk_events ?? []) {
    const slot = chunkEvents?.[ce.part - 1] // parts are numbered from 1; a part number out of range is ignored
    if (slot) slot.push(...new Set(ce.events.filter((e) => known.has(e) && !slot.includes(e))))
  }
  const postEvents = new Set([...(out.events ?? []), ...(chunkEvents ?? []).flat()].filter((e) => known.has(e)))
  return {
    label: out.label === 'noise' ? 'noise' : 'market',
    reason: 'model',
    companies: out.companies ?? [],
    events: [...postEvents],
    ...(chunkEvents ? { chunkEvents } : {}),
    usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    ms,
  }
}

// ---- US symbols -------------------------------------------------------------------------------------

export const SYMBOL_FILES = ['nasdaqlisted', 'otherlisted'] as const
export const symbolFileUrl = (file: typeof SYMBOL_FILES[number]) => `https://www.nasdaqtrader.com/dynamic/SymDir/${file}.txt`
const OTHER_EXCHANGES: Record<string, string> = { N: 'NYSE', A: 'NYSE American', P: 'NYSE Arca', Z: 'Cboe', V: 'IEX' }

/**
 * One of Nasdaq Trader's symbol files: nasdaqlisted.txt (Nasdaq) or otherlisted.txt (NYSE, NYSE American, Arca, Cboe),
 * pipe-separated with a header line and a "File Creation Time" trailer. ETFs and test issues are left out.
 */
export function parseSymbolFile(file: typeof SYMBOL_FILES[number], text: string): Required<UsSymbol>[] {
  const out: Required<UsSymbol>[] = []
  const [header, ...lines] = text.trim().split('\n')
  const cols = header.split('|')
  const at = (name: string) => cols.indexOf(name)
  const iTicker = file === 'nasdaqlisted' ? at('Symbol') : at('ACT Symbol')
  const iName = at('Security Name'), iEtf = at('ETF'), iTest = at('Test Issue'), iExch = at('Exchange')
  if ([iTicker, iName, iEtf, iTest].some((i) => i < 0)) throw new Error(`${file}: unexpected header: ${header.slice(0, 120)}`)
  for (const line of lines) {
    if (line.startsWith('File Creation Time')) continue
    const c = line.split('|')
    if (c[iTest] === 'Y' || c[iEtf] === 'Y' || !c[iTicker]?.trim()) continue
    out.push({
      ticker: normTicker(c[iTicker]),
      name: c[iName].trim(),
      exchange: file === 'nasdaqlisted' ? 'NASDAQ' : (OTHER_EXCHANGES[c[iExch]] ?? c[iExch]),
    })
  }
  return out
}
