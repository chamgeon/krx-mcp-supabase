// Unit tests for Telegram channel names, preview-page parsing and stock tagging. No network: the HTML is inline.
// Run from the repo root: deno task test

import { assertEquals } from 'jsr:@std/assert@1.0.19'
import { channelName, pageProblems, parsePage } from './telegram.ts'

Deno.test('channelName normalizes the ways people paste a channel', () => {
  for (const s of ['@StockNews', 'stocknews', 't.me/stocknews', 'https://t.me/s/stocknews/123', 'https://www.t.me/stocknews?x=1']) {
    assertEquals(channelName(s), 'stocknews', s)
  }
  assertEquals(channelName('abc'), null) // too short (min 4 characters)
  assertEquals(channelName('1stock'), null) // must start with a letter
  assertEquals(channelName('stock-news'), null)
  assertEquals(channelName(''), null)
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

// ---- real preview page --------------------------------------------------------------------------------
// t.me/s/ehdwl as served on 2026-11-16 (fixtures/, saved by `deno task fixtures telegram ehdwl`), tagged with the real
// stock list of 2026-11-13 (the KRX fixtures).

// The fixtures are gitignored (third-party data, public repo): fetch them with `deno task fixtures`. Without them these
// tests are skipped, not failed, so a fresh clone and CI still pass.
const REAL_FILES = [
  new URL('./fixtures/tme_s_ehdwl.html', import.meta.url),
]
const HAVE_REAL = REAL_FILES.every((f) => {
  try {
    return Deno.statSync(f).isFile
  } catch {
    return false
  }
})
if (!HAVE_REAL) console.warn('telegram fixtures missing: real-page tests skipped (run: deno task fixtures)')
const realHtml = HAVE_REAL ? Deno.readTextFileSync(REAL_FILES[0]) : ''
const realPageTest = (name: string, fn: () => void) => Deno.test({ name, ignore: !HAVE_REAL, fn })

realPageTest('real page: 20 posts, in order, with clean text', () => {
  const page = parsePage(realHtml, 'ehdwl')
  assertEquals(page.title, '사제콩이_서상영')
  assertEquals(page.posts.length, 20)
  const ids = page.posts.map((p) => p.msg_id)
  assertEquals(ids, [...ids].sort((a, b) => a - b)) // oldest first, as on the page
  for (const p of page.posts) {
    assertEquals(new Date(p.ts).toISOString().slice(0, 4), '2026', `${p.msg_id} ts`)
    assertEquals(/<[a-z/]/i.test(p.text), false, `${p.msg_id} has HTML left in its text`)
    assertEquals(p.links.every((l) => /^https?:\/\//.test(l)), true, `${p.msg_id} links`)
    assertEquals(p.views === null || p.views > 0, true, `${p.msg_id} views`)
  }
  assertEquals(page.posts.filter((p) => p.text.length > 0).length, 20)
})

// ---- validation (pageProblems): class renames don't make parsePage fail, they make it find less

Deno.test('pageProblems: the inline page has an unparseable post (no time), which is flagged', () => {
  assertEquals(pageProblems(HTML, parsePage(HTML, 'stocknews'), 'stocknews'), ['parsed 2 of 3 posts on the page (page format changed?)'])
})

Deno.test('pageProblems: an empty channel is fine', () => {
  const empty = '<html><head><meta property="og:title" content="Empty"></head><body></body></html>'
  assertEquals(pageProblems(empty, parsePage(empty, 'stocknews'), 'stocknews'), [])
})

realPageTest('pageProblems: the real page passes', () => {
  assertEquals(pageProblems(realHtml, parsePage(realHtml, 'ehdwl'), 'ehdwl'), [])
})

realPageTest('pageProblems: renamed message class (posts not found) is refused', () => {
  const edited = realHtml.replaceAll('tgme_widget_message ', 'tgme_message ').replaceAll('"tgme_widget_message"', '"tgme_message"')
  const page = parsePage(edited, 'ehdwl')
  assertEquals(page.posts.length, 0)
  assertEquals(pageProblems(edited, page, 'ehdwl'), ['parsed 0 of 20 posts on the page (page format changed?)'])
})

realPageTest('pageProblems: renamed text class (posts found, text empty) is refused', () => {
  const edited = realHtml.replaceAll('tgme_widget_message_text', 'tgme_widget_message_body')
  const page = parsePage(edited, 'ehdwl')
  assertEquals(page.posts.length, 20)
  const blank = page.posts.filter((p) => !p.text && !p.has_media).length
  assertEquals(pageProblems(edited, page, 'ehdwl'), [`${blank} of 20 posts have no text and no media (text format changed?)`])
})
