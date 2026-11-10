// lib/module2-access.ts
//
// May this student start / continue this test at all? One rule set for
// POST /api/student/submissions (Start / Resume / Continue to Module 2)
// and the take page's Module 2 recovery, checked before anything is
// created: same QA side, test Published, assigned to the student.
//
// Exception: a student whose latest session has an In Progress submission
// (or a graded M1 awaiting M2 handoff) is mid-attempt. Un-assigning them
// mid-exam must not strand them, so for them the assignment check is
// skipped — but only for resuming/recovering that attempt, never for
// starting a new one (`assigned` tells the caller which).
//
// Full-length SAT parent: mid-attempt = an unclosed full_length_attempts
// row whose Math isn't finished (on the break included), and such an
// attempt may also finish after the test is Closed. New attempts still
// need Published + assigned.

import type { SupabaseClient } from "@supabase/supabase-js";
import { forbidCrossSide } from "@/lib/qa";
import { isTestAssignedToStudent } from "@/lib/student-exam";
import { hasOpenFullLengthAttempt } from "@/lib/full-length";

export interface StudentTestAccess {
  /** Set when the student may not use this test at all. */
  error: { status: number; error: string } | null;
  /** Assigned to the student (needed to start a NEW attempt). */
  assigned: boolean;
}

/** Returns true if the student's latest attempt has any In Progress submission. */
async function latestSessionHasAnyInProgress(db: SupabaseClient, testId: string, studentId: string) {
  // Two-module tests use session_id to link modules; check the latest session.
  const { data: latest } = await db
    .from("submissions")
    .select("session_id")
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .not("session_id", "is", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest?.session_id) {
    const { data: inProgress } = await db
      .from("submissions")
      .select("id")
      .eq("session_id", latest.session_id)
      .eq("student_id", studentId)
      .eq("status", "In Progress")
      .limit(1)
      .maybeSingle();
    if (inProgress) return true;
  }
  // Single-module test (no session_id): check for a direct in-progress row.
  const { data: single } = await db
    .from("submissions")
    .select("id")
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .is("session_id", null)
    .eq("status", "In Progress")
    .limit(1)
    .maybeSingle();
  return Boolean(single);
}

/** Returns true if the latest session has a graded M1 (awaiting M2 handoff). */
async function latestSessionHasGradedModule1(db: SupabaseClient, testId: string, studentId: string) {
  const { data: latest } = await db
    .from("submissions")
    .select("session_id")
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .not("session_id", "is", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest?.session_id) return false;
  const { data: m1 } = await db
    .from("submissions")
    .select("status")
    .eq("session_id", latest.session_id)
    .eq("student_id", studentId)
    .eq("adaptive_track", "module_1")
    .maybeSingle();
  return m1?.status === "Submitted" || m1?.status === "Late";
}

export async function studentTestAccess(
  db: SupabaseClient,
  user: { userId: string; isQa: boolean },
  test: { id: string; status: string | null },
): Promise<StudentTestAccess> {
  const crossSide = await forbidCrossSide(user, { testIds: [test.id] });
  if (crossSide) return { error: { status: 403, error: "Cannot link QA and real accounts/data" }, assigned: false };
  if (test.status !== "Published") {
    if (test.status === "Closed" && (await hasOpenFullLengthAttempt(db, test.id, user.userId))) {
      return { error: null, assigned: false };
    }
    return { error: { status: 403, error: "Test is not available" }, assigned: false };
  }
  // Directly or via a class group, same rule as the My Tests list.
  if (await isTestAssignedToStudent(db, test.id, user.userId)) return { error: null, assigned: true };
  // Allow resuming/recovering an in-progress attempt even if unassigned.
  // This prevents stranding a student mid-exam when an admin unassigns the test.
  // `assigned: false` tells the caller not to allow starting a NEW attempt.
  if (await latestSessionHasAnyInProgress(db, test.id, user.userId)) return { error: null, assigned: false };
  if (await latestSessionHasGradedModule1(db, test.id, user.userId)) return { error: null, assigned: false };
  if (await hasOpenFullLengthAttempt(db, test.id, user.userId)) return { error: null, assigned: false };
  return { error: { status: 403, error: "Test is not assigned to you" }, assigned: false };
}
