// Unit tests for Telegram channel names, preview-page parsing and stock tagging. No network: the HTML is inline.
// Run from the repo root: deno task test

import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.19'
import {
  channelName, directPage, fetchPage, PageNetworkError, pageProblems, type PageSource, parsePage, relayPages, setPageSource,
} from './telegram.ts'

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

// A post the preview can't fully show (custom emoji): the text is one level down, in media_supported_cont, next to a
// "Please open Telegram" notice. Trimmed from t.me/s/stockbot (2026-11-20).
const NOT_SUPPORTED = `<html><body>
<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="stockbot/9139">
  <div class="tgme_widget_message_bubble">
    <div class="tgme_widget_message_author"><a class="tgme_widget_message_owner_name"><span>Trade Watcher</span></a></div>
    <div class="media_supported_cont">
      <a class="tgme_widget_message_photo_wrap" href="https://t.me/stockbot/9139"></a>
      <div class="tgme_widget_message_text js-message_text"><b>Michael Burry</b> doubled puts<br><a href="https://t.me/futures">@futures</a></div>
    </div>
    <div class="media_not_supported_cont"><div class="message_media_not_supported_label">Please open Telegram to view this post</div></div>
    <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date"><time datetime="2026-11-19T21:00:00+00:00"></time></a></span>
  </div>
</div>
<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="stockbot/9140">
  <div class="tgme_widget_message_bubble">
    <div class="media_supported_cont">
      <div class="tgme_widget_message_reply"><div class="tgme_widget_message_text">quoted</div></div>
      <div class="tgme_widget_message_text">text only</div>
    </div>
    <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date"><time datetime="2026-11-19T21:01:00+00:00"></time></a></span>
  </div>
</div>
</body></html>`

Deno.test('parsePage: text of a post the preview can\'t fully show (media_supported_cont)', () => {
  const [a, b] = parsePage(NOT_SUPPORTED, 'stockbot').posts
  assertEquals(a.text, 'Michael Burry doubled puts\n@futures')
  assertEquals(a.links, ['https://t.me/futures'])
  assertEquals(a.has_media, true)
  assertEquals(b.text, 'text only') // own text, not the quoted reply
  assertEquals(b.has_media, false)
})

// Link preview and poll, trimmed from t.me/s/buysellhunter and t.me/s/itechkorea (2026-11-20)
const PREVIEW_AND_POLL = `<html><body>
<div class="tgme_widget_message" data-post="stocknews/201"><div class="tgme_widget_message_bubble">
  <div class="tgme_widget_message_text"><a href="https://m.blog.naver.com/x/1">https://m.blog.naver.com/x/1</a></div>
  <a class="tgme_widget_message_link_preview" href="https://m.blog.naver.com/x/1">
    <div class="link_preview_site_name">NAVER</div>
    <div class="link_preview_title">엔비디아 &quot;전면재검토&quot;</div>
    <div class="link_preview_description">젠슨 황이 떠난   자리 ...</div>
  </a>
  <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date"><time datetime="2026-11-18T06:01:54+00:00"></time></a></span>
</div></div>
<div class="tgme_widget_message" data-post="stocknews/202"><div class="tgme_widget_message_bubble">
  <div class="tgme_widget_message_poll">
    <div class="tgme_widget_message_poll_question">가장 큰 이슈는?</div>
    <div class="tgme_widget_message_poll_type">Anonymous Poll</div>
    <a class="tgme_widget_message_poll_options">
      <div class="tgme_widget_message_poll_option"><div class="tgme_widget_message_poll_option_percent">13%</div>
        <div class="tgme_widget_message_poll_option_value"><div class="tgme_widget_message_poll_option_text">CPI 예상 초과</div></div></div>
      <div class="tgme_widget_message_poll_option"><div class="tgme_widget_message_poll_option_percent">80%</div>
        <div class="tgme_widget_message_poll_option_value"><div class="tgme_widget_message_poll_option_text">엔비디아 급락</div></div></div>
    </a>
  </div>
  <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date"><time datetime="2026-11-19T06:00:00+00:00"></time></a></span>
</div></div>
</body></html>`

Deno.test('parsePage: a link preview adds [site · title] and its description', () => {
  const [p] = parsePage(PREVIEW_AND_POLL, 'stocknews').posts
  assertEquals(p.text, 'https://m.blog.naver.com/x/1\n[NAVER · 엔비디아 "전면재검토"]\n젠슨 황이 떠난 자리 ...')
})

Deno.test('parsePage: a poll adds its question and options, not the percentages (they change with every vote)', () => {
  const p = parsePage(PREVIEW_AND_POLL, 'stocknews').posts[1]
  assertEquals(p.text, '[poll] 가장 큰 이슈는?\n- CPI 예상 초과\n- 엔비디아 급락')
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

// t.me/s/stockbot as served on 2026-11-20 (`deno task fixtures telegram stockbot`): every post is in the
// text_not_supported_wrap layout (text inside media_supported_cont). Skipped without the fixture.
const STOCKBOT = new URL('./fixtures/tme_s_stockbot.html', import.meta.url)
const stockbotHtml = (() => {
  try {
    return Deno.readTextFileSync(STOCKBOT)
  } catch {
    return null
  }
})()

Deno.test({
  name: 'real page: text_not_supported_wrap posts (stockbot) have their text, and the page passes the checks',
  ignore: !stockbotHtml,
  fn: () => {
    const page = parsePage(stockbotHtml!, 'stockbot')
    assertEquals(page.title, 'Trade Watcher')
    assertEquals(page.posts.length, 20)
    assertEquals(page.posts.every((p) => p.text.length > 0), true)
    assertEquals(page.posts.every((p) => !/Please open Telegram/.test(p.text)), true)
    assertEquals(pageProblems(stockbotHtml!, page, 'stockbot'), [])
  },
})

// ---- where pages come from (setPageSource, relayPages) ----------------------------------------------------------

const ONE_POST = `<html><head><meta property="og:title" content="Stock News"></head><body>
<div class="tgme_widget_message" data-post="stocknews/7"><div class="tgme_widget_message_bubble">
<div class="tgme_widget_message_text">hello</div>
<a class="tgme_widget_message_date"><time datetime="2026-11-20T01:00:00+00:00"></time></a></div></div></body></html>`

async function withSource<T>(source: PageSource, fn: () => Promise<T>): Promise<T> {
  setPageSource(source)
  try {
    return await fn()
  } finally {
    setPageSource(directPage)
  }
}

Deno.test('fetchPage: reads from the page source; a redirect is "no preview", another status an error', async () => {
  const asked: unknown[] = []
  const page = await withSource(async (c, b) => (asked.push([c, b]), { status: 200, html: ONE_POST }), () => fetchPage('stocknews', 9))
  assertEquals(asked, [['stocknews', 9]])
  assertEquals(page?.posts.map((p) => p.text), ['hello'])
  assertEquals(await withSource(async () => ({ status: 302, html: '' }), () => fetchPage('stocknews')), null)
  await assertRejects(() => withSource(async () => ({ status: 429, html: '' }), () => fetchPage('stocknews')), Error, 'HTTP 429')
})

async function withFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

Deno.test('relayPages: asks telegram-ingest in the region, with the secret, and returns its answer', async () => {
  let seen: { url: string; headers: Headers } | null = null
  const stub = (async (url: string, init?: RequestInit) => {
    seen = { url, headers: new Headers(init?.headers) }
    return Response.json({ status: 200, html: ONE_POST })
  }) as typeof fetch
  const fallback: PageSource = () => Promise.reject(new Error('fallback used'))
  const raw = await withFetch(stub, () => relayPages('https://x.supabase.co', 's3cret', 'ap-northeast-2', fallback)('stocknews', 42))
  assertEquals(raw.status, 200)
  assertEquals(seen!.url, 'https://x.supabase.co/functions/v1/telegram-ingest?page=stocknews&before=42')
  assertEquals(seen!.headers.get('x-region'), 'ap-northeast-2')
  assertEquals(seen!.headers.get('x-ingest-secret'), 's3cret')
})

Deno.test('relayPages: Telegram\'s redirect passes through; a failed relay falls back to fetching here', async () => {
  const fallback: PageSource = async () => ({ status: 200, html: 'from here' })
  const relay = relayPages('https://x.supabase.co', 's', 'ap-northeast-2', fallback)
  const redirect = await withFetch((async () => Response.json({ status: 302, html: '' })) as typeof fetch, () => relay('stocknews'))
  assertEquals(redirect.status, 302) // Telegram's answer, not a relay failure
  for (const failing of [
    async () => new Response('unauthorized', { status: 401 }),
    async () => Response.json({ error: 'x' }, { status: 502 }),
    async () => Response.json({ unexpected: true }),
    async () => { throw new TypeError('network') },
  ]) {
    const raw = await withFetch(failing as typeof fetch, () => relay('stocknews'))
    assertEquals(raw.html, 'from here')
  }
})

Deno.test('directPage: a network error is tried once more; an HTTP answer is not retried', async () => {
  let calls = 0
  const flaky = (async () => {
    if (++calls === 1) throw new TypeError('client error (SendRequest): connection error: connection reset')
    return new Response(ONE_POST, { status: 200 })
  }) as typeof fetch
  const raw = await withFetch(flaky, () => directPage('stocknews'))
  assertEquals([calls, raw.status, raw.html], [2, 200, ONE_POST])

  calls = 0
  const busy = (async () => (calls++, new Response('slow down', { status: 429 }))) as typeof fetch
  assertEquals((await withFetch(busy, () => directPage('stocknews'))).status, 429)
  assertEquals(calls, 1)
})

Deno.test('directPage: gives up after the second network error; a timeout says so', async () => {
  let calls = 0
  const reset = (async () => { calls++; throw new TypeError('connection reset') }) as typeof fetch
  await assertRejects(() => withFetch(reset, () => directPage('stocknews')), PageNetworkError, 'connection reset')
  assertEquals(calls, 2)

  const hung = (async () => { throw new DOMException('Signal timed out.', 'TimeoutError') }) as typeof fetch
  await assertRejects(() => withFetch(hung, () => directPage('stocknews')), PageNetworkError, 't.me/s/stocknews: no answer in 10 s (2 attempts)')
})

Deno.test('directPage: each attempt has a timeout signal', async () => {
  let signal: AbortSignal | null | undefined
  const stub = (async (_url: string, init?: RequestInit) => (signal = init?.signal, new Response(ONE_POST))) as typeof fetch
  await withFetch(stub, () => directPage('stocknews'))
  assertEquals(signal instanceof AbortSignal, true)
})
