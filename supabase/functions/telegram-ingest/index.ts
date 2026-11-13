// Polls every active public Telegram channel in public.telegram_channels and stores new posts in
// public.telegram_messages (see ../_shared/telegram.ts for how a channel is read).
//
// Called by pg_cron (see sql/cron.example.sql). Protected by the x-ingest-secret header.
//
//   POST /functions/v1/telegram-ingest                 -> poll all active channels (newest page; more if there's a gap)
//   POST /functions/v1/telegram-ingest?channel=ehdwl   -> poll one channel
//   POST /functions/v1/telegram-ingest?retag=1         -> recompute stock tags of all stored posts
//
// Channels that keep failing (e.g. the owner turned the preview off) are retried at most hourly. Returns 500 when any
// channel fails, so failures show up in the function logs.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { loadStockIndex, syncChannel, tagStocks, type SyncResult } from '../_shared/telegram.ts'

const INGEST_SECRET = Deno.env.get('INGEST_SECRET')!
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

// Recomputes stock_codes for every stored post (after the tagging rules or the stock list change).
async function retag() {
  const idx = await loadStockIndex(supabase)
  let scanned = 0
  let changed = 0
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('telegram_messages').select('username, msg_id, text, stock_codes')
      .order('username').order('msg_id').range(from, from + 999)
    if (error) throw new Error(error.message)
    for (const m of data ?? []) {
      scanned++
      const tags = tagStocks(m.text, idx)
      if ([...tags].sort().join() === [...m.stock_codes].sort().join()) continue
      const { error: e } = await supabase.from('telegram_messages').update({ stock_codes: tags })
        .eq('username', m.username).eq('msg_id', m.msg_id)
      if (e) throw new Error(e.message)
      changed++
    }
    if (!data || data.length < 1000) break
  }
  return { retag: true, scanned, changed }
}

const CHANNEL_PAUSE_MS = 300
const FAILING_RETRY_MS = 3600_000

Deno.serve(async (req) => {
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }

  const params = new URL(req.url).searchParams
  if (params.has('retag')) return Response.json(await retag())

  const only = params.get('channel')?.toLowerCase()
  let q = supabase.from('telegram_channels').select('username, poll_errors, last_polled_at').eq('active', true)
  if (only) q = q.eq('username', only)
  const { data: channels, error } = await q.order('last_polled_at', { ascending: true, nullsFirst: true })
  if (error) return Response.json({ error: error.message }, { status: 500 })

  const now = Date.now()
  const due = (channels ?? []).filter((c) =>
    only || c.poll_errors < 3 || !c.last_polled_at || now - new Date(c.last_polled_at).getTime() > FAILING_RETRY_MS
  )

  const idx = await loadStockIndex(supabase)
  const results: SyncResult[] = []
  for (const c of due) {
    if (results.length) await new Promise((r) => setTimeout(r, CHANNEL_PAUSE_MS))
    results.push(await syncChannel(supabase, c.username, idx))
  }

  const failed = results.filter((r) => !r.ok)
  return Response.json(
    { polled: results.length, skipped: (channels?.length ?? 0) - due.length, new_posts: results.reduce((n, r) => n + r.new_posts, 0), results },
    { status: failed.length ? 500 : 200 },
  )
})
