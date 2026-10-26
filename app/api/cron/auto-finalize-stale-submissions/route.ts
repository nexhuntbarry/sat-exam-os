import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { finalizeSubmission } from "@/lib/grade-submission";
import { moduleStartedAtIso, moduleTimeLimitMinutes } from "@/lib/student-exam";

// One-shot grading + DB writes per stale row. Six minutes is the
// largest hammer we need — enough headroom for 50+ rows at a slow
// Supabase pace, still well inside the Fluid Compute ceiling.
export const maxDuration = 60;

// Time a student is allowed to keep an attempt open past the module's
// configured limit before the cron force-grades it. Keeps last-second
// answer auto-saves from getting clipped by a tight cron tick.
const GRACE_MINUTES = 5;

// A Module 2 the student never opened has no clock running (its timer
// starts on first open, metadata.module_2_started_at). Don't grade it as
// a zero while they may still come back; only close it out once it has
// sat untouched this long after the Module 1 handoff.
const UNOPENED_MODULE_2_GRACE_HOURS = 24;

/**
 * Vercel Cron entry point. Walks every `status = 'In Progress'`
 * submission, checks whether the per-module time limit elapsed,
 * and grades the stragglers using the same logic the interactive
 * submit endpoint uses. Designed to be re-run every few minutes
 * with no harm — already-graded rows are filtered out by status.
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
    .select(
      "id, test_id, student_id, answers, started_at, module_id, adaptive_track, session_id, metadata",
    )
    .eq("status", "In Progress")
    .order("started_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!stale || stale.length === 0) {
    return NextResponse.json({ ok: true, scanned: 0, finalized: 0 });
  }

  // Pull every test in one query so we don't fan out for each row.
  const testIds = Array.from(new Set(stale.map((s) => s.test_id)));
  const { data: tests } = await db
    .from("tests")
    .select(
      "id, module_id, question_ids, is_adaptive, due_date, time_limit_minutes, time_limit_minutes_module_2, is_untimed",
    )
    .in("id", testIds);
  const testById = new Map<string, NonNullable<typeof tests>[number]>();
  for (const t of tests ?? []) testById.set(t.id, t);

  const results: Array<{
    submissionId: string;
    studentId: string;
    track: string | null;
    action: "finalized" | "skipped";
    reason?: string;
    score?: number;
    total?: number;
  }> = [];

  for (const sub of stale) {
    const test = testById.get(sub.test_id);
    if (!test) {
      results.push({
        submissionId: sub.id,
        studentId: sub.student_id,
        track: sub.adaptive_track,
        action: "skipped",
        reason: "test row missing",
      });
      continue;
    }

    const limitMinutes = moduleTimeLimitMinutes(test, sub.adaptive_track);
    if (!limitMinutes) {
      results.push({
        submissionId: sub.id,
        studentId: sub.student_id,
        track: sub.adaptive_track,
        action: "skipped",
        reason: "untimed or no time limit configured",
      });
      continue;
    }

    // Same clock the take page and autosave use: Module 2 runs from when
    // the student first opened it, not from the Module 1 handoff.
    const moduleStartIso = moduleStartedAtIso(sub);
    if (!moduleStartIso) {
      const sinceHandoffH = (Date.now() - new Date(sub.started_at).getTime()) / 3_600_000;
      if (sinceHandoffH < UNOPENED_MODULE_2_GRACE_HOURS) {
        results.push({
          submissionId: sub.id,
          studentId: sub.student_id,
          track: sub.adaptive_track,
          action: "skipped",
          reason: `module 2 not opened yet (${Math.round(sinceHandoffH)}h / ${UNOPENED_MODULE_2_GRACE_HOURS}h)`,
        });
        continue;
      }
    } else {
      const elapsedMin = (Date.now() - new Date(moduleStartIso).getTime()) / 60000;
      if (elapsedMin < limitMinutes + GRACE_MINUTES) {
        // Student is still inside their window — leave alone.
        results.push({
          submissionId: sub.id,
          studentId: sub.student_id,
          track: sub.adaptive_track,
          action: "skipped",
          reason: `within window (${Math.round(elapsedMin)}m / ${limitMinutes}m+${GRACE_MINUTES}m grace)`,
        });
        continue;
      }
    }

    try {
      const finalized = await finalizeSubmission({
        submissionId: sub.id,
        submission: {
          id: sub.id,
          test_id: sub.test_id,
          answers: (sub.answers as Record<string, string> | null) ?? null,
          started_at: sub.started_at,
          module_id: sub.module_id,
          adaptive_track: sub.adaptive_track,
          metadata: sub.metadata,
        },
        test: {
          id: test.id,
          module_id: test.module_id,
          question_ids: (test.question_ids as string[] | null) ?? null,
          is_adaptive: test.is_adaptive,
          due_date: test.due_date,
        },
        db,
      });
      if (!finalized) {
        // A student submit (or admin force-submit) won the race.
        results.push({
          submissionId: sub.id,
          studentId: sub.student_id,
          track: sub.adaptive_track,
          action: "skipped",
          reason: "already finalized by another request",
        });
        continue;
      }
      results.push({
        submissionId: sub.id,
        studentId: sub.student_id,
        track: sub.adaptive_track,
        action: "finalized",
        score: finalized.correctCount,
        total: finalized.totalQuestions,
      });
    } catch (e) {
      results.push({
        submissionId: sub.id,
        studentId: sub.student_id,
        track: sub.adaptive_track,
        action: "skipped",
        reason: `finalize error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  const finalized = results.filter((r) => r.action === "finalized").length;
  return NextResponse.json({
    ok: true,
    scanned: stale.length,
    finalized,
    skipped: stale.length - finalized,
    results,
  });
}
