// scripts/apply-migration-0030.ts
//
// Applies supabase/migrations/0030 (one Module 2 per session).
//   1. Dry check with the service-role key: sessions holding more than one
//      Module 2 row would make the unique index fail — must be 0.
//   2. Apply. This repo has no Postgres URL / Supabase CLI link (DDL has so
//      far been pasted into the Supabase SQL editor), so the only scripted
//      route is the Supabase Management API, which needs a personal access
//      token: SUPABASE_ACCESS_TOKEN (supabase.com → Account → Access Tokens).
//      Without it the script stops after the dry check and prints the SQL.
//
//   node --env-file=.env.local --import tsx scripts/apply-migration-0030.ts          # dry check only
//   SUPABASE_ACCESS_TOKEN=sbp_… node --env-file=.env.local --import tsx scripts/apply-migration-0030.ts --apply
//
// CONCURRENTLY: the Management API runs the statement on its own (not in a
// transaction block), so the index is built without locking writes. If the
// API rejects it (25001), the plain form is used — the table is small.
import { createClient } from "@supabase/supabase-js";

const SQL_CONCURRENT = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_submissions_session_module_2
  ON submissions (session_id)
  WHERE session_id IS NOT NULL
    AND adaptive_track IN ('module_2', 'module_2_easy', 'module_2_hard');`;
const SQL_PLAIN = SQL_CONCURRENT.replace(" CONCURRENTLY", "");
const VERIFY_SQL = `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'uniq_submissions_session_module_2';`;

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function dryCheck() {
  const rows: { session_id: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("submissions")
      .select("session_id")
      .not("session_id", "is", null)
      .in("adaptive_track", ["module_2", "module_2_easy", "module_2_hard"])
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as { session_id: string }[]));
    if (!data || data.length < 1000) break;
  }
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.session_id, (count.get(r.session_id) ?? 0) + 1);
  const bad = [...count.entries()].filter(([, n]) => n > 1);
  console.log(`dry check: ${rows.length} Module 2 rows, ${count.size} sessions, ${bad.length} sessions with >1 Module 2`);
  for (const [sid, n] of bad) console.log(`  violating session ${sid}: ${n} rows`);
  return bad.length;
}

async function runSql(token: string, ref: string, query: string) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const violations = await dryCheck();
  if (violations > 0) {
    console.error("NOT applying: fix the duplicate Module 2 rows first.");
    process.exit(1);
  }
  if (!process.argv.includes("--apply")) {
    console.log("dry run only (pass --apply to create the index).");
    return;
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  if (!token) {
    console.error(
      "SUPABASE_ACCESS_TOKEN is not set, so the index can't be created from here.\n" +
        "Paste this into the Supabase SQL editor instead (safe to re-run):\n\n" +
        SQL_PLAIN,
    );
    process.exit(2);
  }
  let r = await runSql(token, ref, SQL_CONCURRENT);
  if (!r.ok && /25001|cannot run inside a transaction/i.test(r.body)) {
    console.log("CONCURRENTLY refused inside a transaction; using the plain form");
    r = await runSql(token, ref, SQL_PLAIN);
  }
  console.log(`apply: HTTP ${r.status} ${r.body.slice(0, 300)}`);
  if (!r.ok) process.exit(1);
  const v = await runSql(token, ref, VERIFY_SQL);
  console.log(`verify: ${v.body.slice(0, 400)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
