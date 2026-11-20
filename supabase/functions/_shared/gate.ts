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
// the rule); v5 written (as in the post) + listed_name (official name on its exchange), posts in any language.
// telegram_messages.gate_version records it.
export const GATE_VERSION = 'v5'

export type GatePost = {
  username: string
  msg_id: number
  ts: string
  text: string
  has_media: boolean
  forwarded_from: string | null
}
// What the gate reads of a post (Telegram's or X's: the source's own key isn't part of it)
export type GateInput = Omit<GatePost, 'msg_id'>
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
 */
export function checker(stocks: Stock[], symbols: UsSymbol[]) {
  const byCode = new Map(stocks.map((s) => [s.isu_cd, s]))
  const byName = new Map(stocks.map((s) => [norm(s.isu_nm), s.isu_cd]))
  const aliases = new Map(STOCK_ALIASES.filter(([, c]) => byCode.has(c)).map(([a, c]) => [norm(a), c]))
  const usName = new Map(symbols.map((s) => [normTicker(s.ticker), s.name]))
  const usAlias = new Map(US_ALIASES.filter(([, t]) => usName.has(t)).map(([a, t]) => [coreName(a), t]))
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
      }
    }
    return { kr: [...kr].sort(), us: [...us].sort(), usByName: [...usByName], rejected }
  }
}

// ---- the model call ---------------------------------------------------------------------------------

export function systemPrompt(events: GateEvent[]): string {
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
${events.length ? events.map((e) => `- ${e.id}: ${e.description}`).join('\n') : '(no events)'}`
}

export function outputSchema(events: GateEvent[]) {
  return {
    type: 'object',
    additionalProperties: false,
    // No events to choose from (a post older than every event window): no events field at all. Structured outputs
    // reject array constraints such as maxItems (log 2026-11-20); askGate reads a missing events as none.
    required: events.length ? ['label', 'companies', 'events'] : ['label', 'companies'],
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
      ...(events.length ? { events: { type: 'array', items: { type: 'string', enum: events.map((e) => e.id) } } } : {}),
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
    p.text,
    '</post>',
  ].join('\n')
}

export type GateAnswer = {
  label: 'market' | 'noise'
  reason: 'empty' | 'model' // empty: no text, labeled noise without a call
  companies: Company[]
  events: string[]
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
  const format = { type: 'json_schema' as const, schema: outputSchema(events) }
  const res = await client.messages.create({
    model: GATE_MODEL,
    max_tokens: 8000, // long digests list dozens of companies
    system: systemPrompt(events),
    messages: [{ role: 'user', content: userMessage(post) }],
    ...(opts.thinking
      ? { output_config: { effort: 'low' as const, format } }
      : { thinking: { type: 'disabled' as const }, output_config: { format } }),
  })
  const ms = Math.round(performance.now() - t0)
  if (res.stop_reason !== 'end_turn') throw new Error(`stop_reason ${res.stop_reason}`)
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  const out = JSON.parse(text) as { label: 'market' | 'noise'; companies: Company[]; events: string[] }
  const known = new Set(events.map((e) => e.id))
  return {
    label: out.label === 'noise' ? 'noise' : 'market',
    reason: 'model',
    companies: out.companies ?? [],
    events: (out.events ?? []).filter((e) => known.has(e)),
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
