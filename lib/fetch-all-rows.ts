// lib/fetch-all-rows.ts
//
// PostgREST (Supabase) returns at most 1000 rows per request and drops the
// rest without an error. answer_records outgrows that fast (one row per
// question per module: 25 students × 44 questions = 1100), which silently
// cut students out of CSV exports and analytics. Page through instead.

const PAGE = 1000;

/**
 * Run `query(from, to)` for consecutive ranges until a short page comes
 * back. The query must apply `.range(from, to)` and a stable `.order(...)`.
 */
export async function fetchAllRows<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<{ data: T[]; error: unknown }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) return { data: rows, error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return { data: rows, error: null };
  }
}
