// Reading every row of a query. PostgREST answers at most 1,000 rows (Supabase's max_rows), whatever `.limit()` asks
// for, and says nothing when it cuts: a query that may pass 1,000 rows has to page. (The 18:00 report read
// ingest_runs with .limit(5000) and lost every run after the 1,000th, log 2026-11-28.)

export const PAGE_ROWS = 1000

type Page<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>

/** Every row of a query, PAGE_ROWS at a time. `page(from, to)` is the query with `.range(from, to)` and a stable order. */
export async function allRows<T>(page: Page<T>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if ((data ?? []).length < PAGE_ROWS) return out
  }
}
