// Unit tests for X handles and the actor's records → rows. No network.
// Run from the repo root: deno task test

import { assert, assertEquals } from 'jsr:@std/assert@1.0.19'
import { accountName, toRow, type XItem } from './x.ts'

Deno.test('accountName normalizes the ways people paste an account', () => {
  for (const s of ['@CharlieBilello', 'charliebilello', 'x.com/charliebilello', 'https://twitter.com/charliebilello/status/1', 'https://www.x.com/@charliebilello']) {
    assertEquals(accountName(s), 'charliebilello', s)
  }
  assertEquals(accountName('a_very_long_handle_name'), null) // over 15 characters
  assertEquals(accountName('no-dashes'), null)
  assertEquals(accountName(''), null)
})

const post = (over: Partial<XItem> = {}): XItem => ({
  id: '2123635272340689146',
  type: 'tweet',
  text: 'US IPO issuance has surged to $261 billion in 2026. https://t.co/swtJNGE6Mn',
  url: 'https://x.com/charliebilello/status/2123635272340689146',
  lang: 'en',
  createdAt: 'Fri Nov 20 04:31:18 +0000 2026',
  viewCount: 15004,
  likeCount: 80,
  retweetCount: 12,
  replyCount: 20,
  media: [{ type: 'photo', mediaUrl: 'https://pbs.twimg.com/media/HXim8wcXcAAcvgv.png' }],
  entities: { urls: [{ expanded_url: 'https://example.com/a' }, { expanded_url: 'https://example.com/a' }] },
  author: { id: '1413027896', username: 'charliebilello', name: 'Charlie Bilello' },
  ...over,
})

Deno.test('toRow: a post becomes a row: time, text without its trailing media link, images, links, counts', () => {
  const r = toRow(post())!
  assertEquals([r.id, r.username, r.ts], ['2123635272340689146', 'charliebilello', '2026-11-20T04:31:18.000Z'])
  assertEquals(r.text, 'US IPO issuance has surged to $261 billion in 2026.')
  assertEquals([r.media, r.links], [['https://pbs.twimg.com/media/HXim8wcXcAAcvgv.png'], ['https://example.com/a']])
  assertEquals([r.views, r.likes, r.reposts, r.replies, r.is_reply, r.quoted_text], [15004, 80, 12, 20, false, null])
})

Deno.test('toRow: retweets and records without an id, time or author are dropped; long posts use their full text', () => {
  assertEquals(toRow(post({ isRetweet: true })), null)
  assertEquals(toRow(post({ type: 'retweet' })), null)
  assertEquals(toRow(post({ id: undefined })), null)
  assertEquals(toRow(post({ createdAt: 'not a date' })), null)
  assertEquals(toRow(post({ author: null })), null)
  assertEquals(toRow(post({ text: 'cut…', noteTweet: { text: 'the whole long post' } }))!.text, 'the whole long post')
  const q = toRow(post({ isReply: true, quoted_tweet: { id: '1', text: ' Silver tripled ' }, quotedTweetPermalink: 'https://x.com/charliebilello/status/1' }))!
  assertEquals([q.is_reply, q.quoted_text, q.quoted_url], [true, 'Silver tripled', 'https://x.com/charliebilello/status/1'])
})

const REAL = new URL('./fixtures/x_charliebilello.json', import.meta.url)
const real = (() => {
  try {
    return JSON.parse(Deno.readTextFileSync(REAL)) as XItem[]
  } catch {
    return null
  }
})()
Deno.test({
  name: 'toRow on a real answer (@charliebilello, 2026-11-20, retweets included): only his own posts, all with text and time',
  ignore: !real, // gitignored fixture (third-party data)
  fn: () => {
    const rows = real!.map(toRow).filter((r) => r !== null)
    assertEquals(rows.length, real!.filter((i) => !i.isRetweet).length)
    assertEquals(rows.length, 8) // 7 posts and 1 quote-reply; the 12 retweets dropped
    for (const r of rows) assert(r!.username === 'charliebilello' && r!.text && r!.ts.startsWith('2026-'), JSON.stringify(r))
    assert(rows.some((r) => r!.media.length), 'charts come as image URLs')
  },
})
