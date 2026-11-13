// lib/start-race.ts
//
// Start pressed several times at once (two tabs, phone + laptop, a resend
// on a slow network) on POST /api/student/submissions. Every request must
// land on the same single attempt:
//
//  - One read of the student's rows for the test gives both "is there an
//    In Progress row?" and the highest attempt number from the same
//    snapshot, so a request that sees another's new row resumes it instead
//    of treating it as a finished attempt (→ "Retake not allowed", or a
//    second attempt on a retakes-allowed test).
//  - Requests that read the same snapshot compute the same attempt number,
//    so their inserts collide on uniq_submissions_attempt_legacy /
//    uniq_submissions_attempt_adaptive (0017): the loser gets 23505 and
//    resumes the winner's row.
//  - The winner consumes the retake grant only after its insert, so a
//    request that finds the grant already used re-reads before refusing.
//
// Kept free of next/* so the unit tests can load it.
import type { SupabaseClient } from "@supabase/supabase-js";

export type StartRow = {
  id: string;
  attempt_number: number;
  status: string;
  started_at: string | null;
};

/** Resume the newest In Progress row, else the highest prior attempt (null = first start). */
export function startPlan(rows: StartRow[]): { resumeId: string } | { priorMax: number | null } {
  let resume: StartRow | null = null;
  let priorMax: number | null = null;
  for (const r of rows) {
    if (priorMax === null || r.attempt_number > priorMax) priorMax = r.attempt_number;
    if (r.status !== "In Progress") continue;
    const t = r.started_at ? Date.parse(r.started_at) : 0;
    const best = resume?.started_at ? Date.parse(resume.started_at) : 0;
    if (!resume || t > best || (t === best && r.id > resume.id)) resume = r;
  }
  return resume ? { resumeId: resume.id } : { priorMax };
}

/** All of the student's submission rows for a test (a handful per attempt). */
export async function studentStartRows(
  db: SupabaseClient,
  testId: string,
  studentId: string,
): Promise<StartRow[]> {
  const { data, error } = await db
    .from("submissions")
    .select("id, attempt_number, status, started_at")
    .eq("test_id", testId)
    .eq("student_id", studentId)
    // Re-read within one request: opt out of any fetch memoization.
    .abortSignal(new AbortController().signal);
  if (error) throw new Error(`submissions lookup: ${error.message}`);
  return (data ?? []) as StartRow[];
}

/** The In Progress row a concurrent start created, if any. */
export async function concurrentStartId(
  db: SupabaseClient,
  testId: string,
  studentId: string,
): Promise<string | null> {
  const plan = startPlan(await studentStartRows(db, testId, studentId));
  return "resumeId" in plan ? plan.resumeId : null;
}
