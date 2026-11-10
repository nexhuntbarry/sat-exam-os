import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import {
  finalizeStaleSubmission,
  STALE_SUBMISSION_COLUMNS,
  STALE_TEST_COLUMNS,
  type StaleResult,
  type StaleSubmission,
  type StaleTest,
} from "@/lib/finalize-stale";
import { closeExpiredFullLengthAttempts } from "@/lib/full-length-attempt";

// One-shot grading + DB writes per stale row. Six minutes is the
// largest hammer we need — enough headroom for 50+ rows at a slow
// Supabase pace, still well inside the Fluid Compute ceiling.
export const maxDuration = 60;

/**
 * Vercel Cron entry point. Walks every `status = 'In Progress'`
 * submission, checks whether the per-module time limit elapsed,
 * and grades the stragglers using the same logic the interactive
 * submit endpoint uses. Designed to be re-run every few minutes
 * with no harm — already-graded rows are filtered out by status.
 * A Module 1 it closes gets its Module 2 row right away (same idempotent
 * handoff as a student submit), unopened — the Module 2 clock starts only
 * when the student presses "Start Module 2". Per-row logic lives in
 * lib/finalize-stale.
 *
 * Then a separate pass closes full-length SAT attempts whose Math can no
 * longer be started (lib/full-length-attempt closeExpiredFullLengthAttempts;
 * it never creates Math rows). Its own try/catch: it can't affect the loop
 * above. The response adds flClosed.
 *
 * Auth: Vercel injects `Authorization: Bearer <CRON_SECRET>` on
 * scheduled invocations. Manual calls from the admin should pass
 * the same header.
 */
export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  const provided = req.headers.get("authorization") ?? "";
  if (expected && provided !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getServiceClient();
  const { data: stale, error } = await db
    .from("submissions")
    .select(STALE_SUBMISSION_COLUMNS)
    .eq("status", "In Progress")
    .order("started_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!stale || stale.length === 0) {
    return NextResponse.json({ ok: true, scanned: 0, finalized: 0, flClosed: await flClosePass(db) });
  }
  const rows = stale as unknown as StaleSubmission[];

  // Pull every test in one query so we don't fan out for each row.
  const testIds = Array.from(new Set(rows.map((s) => s.test_id)));
  const { data: tests } = await db.from("tests").select(STALE_TEST_COLUMNS).in("id", testIds);
  const testById = new Map<string, StaleTest>();
  for (const t of (tests ?? []) as unknown as StaleTest[]) testById.set(t.id, t);

  const results: StaleResult[] = [];
  for (const sub of rows) {
    results.push(await finalizeStaleSubmission(db, sub, testById.get(sub.test_id)));
  }

  const finalized = results.filter((r) => r.action === "finalized").length;
  const flClosed = await flClosePass(db);
  return NextResponse.json({
    ok: true,
    scanned: rows.length,
    finalized,
    skipped: rows.length - finalized,
    flClosed,
    results,
  });
}

// Full-length close pass; never throws (0 on any failure, logged).
async function flClosePass(db: ReturnType<typeof getServiceClient>): Promise<number> {
  try {
    const out = await closeExpiredFullLengthAttempts(db);
    if (out.errors.length > 0) console.error("[cron/fl-close]", out.errors.slice(0, 10));
    return out.closed;
  } catch (e) {
    console.error("[cron/fl-close] pass failed", e);
    return 0;
  }
}
