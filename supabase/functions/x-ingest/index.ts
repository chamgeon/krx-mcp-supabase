// Collects posts from every active X account in public.x_accounts through an Apify actor (see ../_shared/x.ts).
//
// Called by pg_cron every 5 minutes (sql/cron.example.sql). Protected by the x-ingest-secret header.
//
//   POST /functions/v1/x-ingest   -> backfill accounts never polled (their latest 20 posts), then one run for the
//                                    rest: posts since their last poll
//
// Needs the APIFY_API_KEY secret (the one youtube-ingest uses). Returns 500 when the actor call fails, so ingest_runs
// records it and the operator is alerted (hourly at most); the next run asks again from the same point, so nothing
// is missed.

import 'jsr:@supabase/functions-js@2.119.0/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { monitored } from '../_shared/ops.ts'
import { pollAccounts, xquikPosts } from '../_shared/x.ts'

const INGEST_SECRET = Deno.env.get('INGEST_SECRET')!
const APIFY_API_KEY = Deno.env.get('APIFY_API_KEY')
const HERE_REGION = Deno.env.get('SB_REGION') || null // set by Supabase; unset locally
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

Deno.serve(monitored('x-ingest', supabase, async (req) => {
  if (req.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!APIFY_API_KEY) return Response.json({ error: 'APIFY_API_KEY is not set' }, { status: 500 })
  const sum = await pollAccounts(supabase, xquikPosts(APIFY_API_KEY))
  const failed = sum.backfilled.filter((b) => !b.ok)
  const error = [sum.error, ...failed.map((b) => `${b.account}: ${b.error}`)].filter(Boolean).join('; ')
  return Response.json({ ran_in: HERE_REGION, ...sum, ...(error ? { error } : {}) }, { status: error ? 500 : 200 })
}))
