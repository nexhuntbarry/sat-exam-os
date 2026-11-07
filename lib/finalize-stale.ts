// lib/finalize-stale.ts
//
// Per-row work of the cron finalizer (app/api/cron/auto-finalize-stale-
// submissions): decide whether one In Progress submission is past its
// module time, grade it if so, and hand a closed Module 1 off to Module 2.
// Split out of the route so it can be exercised on a single (QA) row.

import type { SupabaseClient } from "@supabase/supabase-js";
import { finalizeSubmission } from "@/lib/grade-submission";
import { moduleStartedAtIso, moduleTimeLimitMinutes } from "@/lib/student-exam";
import { ensureModule2, HANDOFF_TEST_COLUMNS, type HandoffTest } from "@/lib/module2-handoff";

// Time a student is allowed to keep an attempt open past the module's
// configured limit before the cron force-grades it. Keeps last-second
// answer auto-saves from getting clipped by a tight cron tick.
export const GRACE_MINUTES = 5;

// A Module 2 the student never opened has no clock running (its timer
// starts on first open, metadata.module_2_started_at). Don't grade it as
// a zero while they may still come back; only close it out once it has
// sat untouched this long after the Module 1 handoff.
export const UNOPENED_MODULE_2_GRACE_HOURS = 24;

export const STALE_SUBMISSION_COLUMNS =
  "id, test_id, student_id, answers, started_at, module_id, adaptive_track, session_id, metadata, attempt_number";
export const STALE_TEST_COLUMNS = `id, module_id, question_ids, due_date, time_limit_minutes, time_limit_minutes_module_2, is_untimed, ${HANDOFF_TEST_COLUMNS}`;

export interface StaleSubmission {
  id: string;
  test_id: string;
  student_id: string;
  answers: unknown;
  started_at: string;
  module_id: string | null;
  adaptive_track: string | null;
  session_id: string | null;
  metadata: unknown;
  attempt_number: number;
}

export interface StaleTest extends HandoffTest {
  id: string;
  module_id: string | null;
  question_ids: unknown;
  due_date: string | null;
  time_limit_minutes: number | null;
  time_limit_minutes_module_2: number | null;
  is_untimed: boolean | null;
}

export interface StaleResult {
  submissionId: string;
  studentId: string;
  track: string | null;
  action: "finalized" | "skipped";
  reason?: string;
  score?: number;
  total?: number;
  /** Module 1 only: the Module 2 row the student continues with. */
  module2Id?: string | null;
  handoffError?: string;
}

export async function finalizeStaleSubmission(
  db: SupabaseClient,
  sub: StaleSubmission,
  test: StaleTest | undefined,
): Promise<StaleResult> {
  const base = { submissionId: sub.id, studentId: sub.student_id, track: sub.adaptive_track };
  if (!test) return { ...base, action: "skipped", reason: "test row missing" };

  const limitMinutes = moduleTimeLimitMinutes(test, sub.adaptive_track);
  if (!limitMinutes) {
    return { ...base, action: "skipped", reason: "untimed or no time limit configured" };
  }

  // Same clock the take page and autosave use: Module 2 runs from when
  // the student first opened it, not from the Module 1 handoff.
  const moduleStartIso = moduleStartedAtIso(sub);
  if (!moduleStartIso) {
    const sinceHandoffH = (Date.now() - new Date(sub.started_at).getTime()) / 3_600_000;
    if (sinceHandoffH < UNOPENED_MODULE_2_GRACE_HOURS) {
      return {
        ...base,
        action: "skipped",
        reason: `module 2 not opened yet (${Math.round(sinceHandoffH)}h / ${UNOPENED_MODULE_2_GRACE_HOURS}h)`,
      };
    }
  } else {
    const elapsedMin = (Date.now() - new Date(moduleStartIso).getTime()) / 60000;
    if (elapsedMin < limitMinutes + GRACE_MINUTES) {
      // Student is still inside their window — leave alone.
      return {
        ...base,
        action: "skipped",
        reason: `within window (${Math.round(elapsedMin)}m / ${limitMinutes}m+${GRACE_MINUTES}m grace)`,
      };
    }
  }

  let finalized;
  try {
    finalized = await finalizeSubmission({
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
        // Needed for the "started on time" rule (an admin moving the due
        // date earlier mustn't make an on-time student Late).
        time_limit_minutes: test.time_limit_minutes,
        time_limit_minutes_module_2: test.time_limit_minutes_module_2,
        is_untimed: test.is_untimed,
      },
      // Never opened: 0 time spent, flagged so analytics leave it out.
      autoClosedUnopened: !moduleStartIso,
      db,
    });
  } catch (e) {
    return { ...base, action: "skipped", reason: `finalize error: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!finalized) {
    // A student submit (or admin force-submit) won the race.
    return { ...base, action: "skipped", reason: "already finalized by another request" };
  }

  // Module 1 closed by the clock: hand off to Module 2 exactly like a
  // student submit, so the student lands on "Start Module 2" instead of a
  // finished-looking Module 1. The new row is unopened, so its clock only
  // starts when the student presses Start. A failure here is recovered
  // when the student opens the test (take page / Continue to Module 2).
  let module2Id: string | null | undefined;
  let handoffError: string | undefined;
  if (sub.adaptive_track === "module_1" && sub.session_id) {
    try {
      module2Id =
        (
          await ensureModule2(
            db,
            {
              test_id: sub.test_id,
              student_id: sub.student_id,
              session_id: sub.session_id,
              attempt_number: sub.attempt_number,
              adaptive_track: sub.adaptive_track,
            },
            test,
            { module1Percentage: finalized.percentage },
          )
        )?.id ?? null;
    } catch (e) {
      handoffError = e instanceof Error ? e.message : String(e);
      console.error("[cron/auto-finalize] module 2 handoff", sub.id, handoffError);
    }
  }

  return {
    ...base,
    action: "finalized",
    score: finalized.correctCount,
    total: finalized.totalQuestions,
    ...(module2Id !== undefined ? { module2Id } : {}),
    ...(handoffError ? { handoffError } : {}),
  };
}
