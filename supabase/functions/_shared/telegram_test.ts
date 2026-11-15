// Unit tests for Telegram channel names, preview-page parsing and stock tagging. No network: the HTML is inline.
// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1'
import { buildStockIndex, channelName, parsePage, tagStocks } from './telegram.ts'

Deno.test('channelName normalizes the ways people paste a channel', () => {
  for (const s of ['@StockNews', 'stocknews', 't.me/stocknews', 'https://t.me/s/stocknews/123', 'https://www.t.me/stocknews?x=1']) {
    assertEquals(channelName(s), 'stocknews', s)
  }
  assertEquals(channelName('abc'), null) // too short (min 4 characters)
  assertEquals(channelName('1stock'), null) // must start with a letter
  assertEquals(channelName('stock-news'), null)
  assertEquals(channelName(''), null)
})

// ---- tagging --------------------------------------------------------------------------------------

const idx = buildStockIndex([
  { isu_cd: '005930', isu_nm: '삼성전자' },
  { isu_cd: '005935', isu_nm: '삼성전자우' },
  { isu_cd: '000660', isu_nm: 'SK하이닉스' },
  { isu_cd: '373220', isu_nm: 'LG에너지솔루션' },
  { isu_cd: '352820', isu_nm: '하이브' },
  { isu_cd: '001680', isu_nm: '대상' }, // 2 characters: never matched by name
  { isu_cd: '123456', isu_nm: '케이프' },
])

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

// ---- preview page parsing ---------------------------------------------------------------------------

// Trimmed copy of the t.me/s/<channel> markup (only the parts parsePage reads)
const HTML = `<!DOCTYPE html><html><head><meta property="og:title" content="Stock News"></head><body>
<div class="tgme_widget_message" data-post="stocknews/101">
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_forwarded_from"><a class="tgme_widget_message_forwarded_from_name">Other Channel</a></div>
    <div class="tgme_widget_message_reply"><div class="tgme_widget_message_text">quoted reply text</div></div>
    <div class="tgme_widget_message_text">첫 줄<br>둘째 줄 <a href="https://example.com/a">link</a> <a href="https://example.com/a">dup</a> <a href="tg://x">app</a></div>
    <div class="tgme_widget_message_photo_wrap"></div>
    <div class="tgme_widget_message_footer"><div class="tgme_widget_message_info">
      <span class="tgme_widget_message_views">1.2K</span>
      <span class="tgme_widget_message_meta">edited <a class="tgme_widget_message_date"><time datetime="2026-11-13T01:02:03+00:00"></time></a></span>
    </div></div>
  </div>
</div>
<div class="tgme_widget_message" data-post="stocknews/102">
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_document"><div class="tgme_widget_message_document_title">report.pdf</div></div>
    <span class="tgme_widget_message_views">4.09M</span>
    <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date"><time datetime="2026-11-13T02:00:00+00:00"></time></a></span>
  </div>
</div>
<div class="tgme_widget_message" data-post="otherchannel/5">
  <div class="tgme_widget_message_bubble"><div class="tgme_widget_message_text">embedded</div>
  <a class="tgme_widget_message_date"><time datetime="2026-11-13T03:00:00+00:00"></time></a></div>
</div>
<div class="tgme_widget_message" data-post="stocknews/103"><div class="tgme_widget_message_bubble">no time</div></div>
</body></html>`

Deno.test('parsePage reads posts, skips embeds and posts without a time', () => {
  const page = parsePage(HTML, 'stocknews')
  assertEquals(page.title, 'Stock News')
  assertEquals(page.posts.map((p) => p.msg_id), [101, 102])
})

Deno.test('parsePage: text, links, views and flags of a post', () => {
  const [p] = parsePage(HTML, 'stocknews').posts
  assertEquals(p.text, '첫 줄\n둘째 줄 link dup app') // own text only, not the quoted reply
  assertEquals(p.links, ['https://example.com/a']) // deduped, http(s) only
  assertEquals(p.views, 1200)
  assertEquals(p.forwarded_from, 'Other Channel')
  assertEquals(p.has_media, true)
  assertEquals(p.edited, true)
  assertEquals(p.ts, '2026-11-13T01:02:03+00:00')
})

Deno.test('parsePage: document title becomes text, M views', () => {
  const p = parsePage(HTML, 'stocknews').posts[1]
  assertEquals(p.text, '[report.pdf]')
  assertEquals(p.views, 4_090_000)
  assertEquals(p.has_media, true)
  assertEquals(p.edited, false)
  assertEquals(p.forwarded_from, null)
})
