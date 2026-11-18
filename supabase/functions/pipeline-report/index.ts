// Daily data-pipeline report to the operator's Telegram, at 18:00 KST (pg_cron, see sql/cron.example.sql).
// Covers the 24 hours before 18:00: yesterday's 18:00 KIS run through today's runs before 18:00 (today's 18:00 run is
// in tomorrow's report). Built from public.ingest_runs, which every ingest function writes (../_shared/ops.ts).
// No message at 18:00 means this function itself failed.
//
//   POST /functions/v1/pipeline-report   (x-ingest-secret header) -> sends the report; answers { sent, text }

import 'jsr:@supabase/functions-js@2.119.0/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { sendTelegram } from '../_shared/ops.ts'
import { buildReport, reportWindowEnd, type Run } from './report.ts'

const KEEP_RUNS_DAYS = 90

const INGEST_SECRET = Deno.env.get('INGEST_SECRET')!
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

Deno.serve(async (req) => {
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }
  try {
    const end = reportWindowEnd(new Date())
    const start = new Date(end.getTime() - 86400_000)
    const todayIso = new Date(end.getTime() + 9 * 3600_000).toISOString().slice(0, 10)

    const [runs, pending, latest, channels] = await Promise.all([
      supabase.from('ingest_runs').select('job, started_at, ok, summary, error')
        .gte('started_at', start.toISOString()).lt('started_at', end.toISOString())
        .order('started_at').limit(5000),
      // krx-ingest deletes a day's KIS rows once KRX's data is in, so a provisional day before today is one KRX
      // hasn't loaded. Holidays never get KIS rows, so they can't show up here.
      supabase.from('available_dates').select('bas_dd').eq('final', false).lt('bas_dd', todayIso).order('bas_dd'),
      supabase.from('trading_days').select('bas_dd, row_count').order('bas_dd', { ascending: false }).limit(1),
      supabase.from('telegram_channels').select('username, last_error').eq('active', true).gt('poll_errors', 0),
    ])
    for (const r of [runs, pending, latest, channels]) if (r.error) throw new Error(r.error.message)

    const text = buildReport({
      end,
      runs: (runs.data ?? []) as Run[],
      pendingKrxDays: (pending.data ?? []).map((d) => d.bas_dd),
      krxLatest: latest.data?.[0] ?? null,
      channelErrors: channels.data ?? [],
    })
    const sent = await sendTelegram(text)

    const { error } = await supabase.from('ingest_runs').delete()
      .lt('started_at', new Date(Date.now() - KEEP_RUNS_DAYS * 86400_000).toISOString())
    if (error) console.error('ingest_runs cleanup failed:', error.message)

    return Response.json({ sent, text }, { status: sent ? 200 : 500 })
  } catch (e) {
    const message = (e as Error).message
    await sendTelegram(`❌ pipeline-report failed: ${message.slice(0, 600)}`)
    return Response.json({ error: message }, { status: 500 })
  }
})
