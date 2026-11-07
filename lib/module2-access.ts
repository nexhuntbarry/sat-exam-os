// lib/module2-access.ts
//
// May this student start / continue this test at all? One rule set for
// POST /api/student/submissions (Start / Resume / Continue to Module 2)
// and the take page's Module 2 recovery, checked before anything is
// created: same QA side, test Published, assigned to the student.
//
// Exception: a student whose latest session already has a graded Module 1
// is mid-attempt. Un-assigning them mid-exam must not strand them between
// modules, so for them the assignment check is skipped — but only for
// recovering / resuming that attempt, never for starting a new one
// (`assigned` tells the caller which).

import type { SupabaseClient } from "@supabase/supabase-js";
import { forbidCrossSide } from "@/lib/qa";
import { isTestAssignedToStudent } from "@/lib/student-exam";

export interface StudentTestAccess {
  /** Set when the student may not use this test at all. */
  error: { status: number; error: string } | null;
  /** Assigned to the student (needed to start a NEW attempt). */
  assigned: boolean;
}

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
  if (test.status !== "Published") return { error: { status: 403, error: "Test is not available" }, assigned: false };
  // Directly or via a class group, same rule as the My Tests list.
  if (await isTestAssignedToStudent(db, test.id, user.userId)) return { error: null, assigned: true };
  if (await latestSessionHasGradedModule1(db, test.id, user.userId)) return { error: null, assigned: false };
  return { error: { status: 403, error: "Test is not assigned to you" }, assigned: false };
}
