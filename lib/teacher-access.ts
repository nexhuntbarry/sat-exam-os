// Shared authz helper for /api/teacher/* endpoints.
//
// Two-track access model (matches /teacher/results, /teacher/analysis,
// /teacher/classes pages):
//   A) Direct: teacher is listed in test_assignments.teacher_ids.
//      Gives full scope on the test (all students). Use for non-class
//      reviewers / co-teachers.
//   B) Class: teacher owns a class_group via class_group_teachers AND
//      at least one of that group's students has activity on the test.
//      Gives scope limited to the teacher's own class students.
//
// Either track grants read access; track B is the common case after we
// stopped requiring admins to populate teacher_ids on every test.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TeacherTestAccess {
  /**
   * "admin" – unrestricted (caller is admin).
   * "direct" – caller is on test_assignments.teacher_ids; sees every
   *            submission on the test.
   * "class"  – caller is a class teacher; sees only their class members'
   *            submissions. Use `studentAllowlist` to scope queries.
   * null     – caller has no access; return 403.
   */
  mode: "admin" | "direct" | "class" | null;
  /**
   * Only populated when mode === "class". Caller-side queries must
   * intersect with this set before returning data.
   */
  studentAllowlist: Set<string> | null;
}

export async function getTeacherTestAccess(
  db: SupabaseClient,
  user: { userId: string; role: string | null | undefined },
  testId: string,
): Promise<TeacherTestAccess> {
  if (user.role === "admin") {
    return { mode: "admin", studentAllowlist: null };
  }

  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids")
    .eq("test_id", testId)
    .maybeSingle();
  const teacherIds = (assignment?.teacher_ids as string[] | null) ?? [];
  if (teacherIds.includes(user.userId)) {
    return { mode: "direct", studentAllowlist: null };
  }

  // Class-group fallback.
  const { data: myGroups } = await db
    .from("class_group_teachers")
    .select("class_group_id")
    .eq("teacher_id", user.userId);
  const groupIds = (myGroups ?? []).map((g) => g.class_group_id as string);
  if (groupIds.length === 0) return { mode: null, studentAllowlist: null };

  const { data: members } = await db
    .from("class_group_members")
    .select("student_id")
    .in("class_group_id", groupIds);
  const allowlist = new Set((members ?? []).map((m) => m.student_id as string));
  if (allowlist.size === 0) return { mode: null, studentAllowlist: null };

  return { mode: "class", studentAllowlist: allowlist };
}

export interface TeacherTestScope {
  /** Tests the teacher is on test_assignments.teacher_ids for. */
  directTestIds: Set<string>;
  /**
   * Tests where at least one of the teacher's class students has a
   * submission. Includes overlap with directTestIds — callers usually
   * want `directTestIds ∪ classTestIds`.
   */
  classTestIds: Set<string>;
  /**
   * Every student in the teacher's class_groups. Used to scope
   * cohort/skill analytics queries.
   */
  myStudentIds: Set<string>;
  /** admin → full unrestricted scope (callers should bypass filters). */
  isAdmin: boolean;
}

export async function getTeacherTestScope(
  db: SupabaseClient,
  user: { userId: string; role: string | null | undefined },
): Promise<TeacherTestScope> {
  const out: TeacherTestScope = {
    directTestIds: new Set(),
    classTestIds: new Set(),
    myStudentIds: new Set(),
    isAdmin: user.role === "admin",
  };
  if (out.isAdmin) return out;

  const { data: directly } = await db
    .from("test_assignments")
    .select("test_id")
    .contains("teacher_ids", JSON.stringify([user.userId]));
  for (const a of directly ?? []) {
    out.directTestIds.add(a.test_id as string);
  }

  const { data: myGroups } = await db
    .from("class_group_teachers")
    .select("class_group_id")
    .eq("teacher_id", user.userId);
  const groupIds = (myGroups ?? []).map((g) => g.class_group_id as string);
  if (groupIds.length === 0) return out;

  const { data: members } = await db
    .from("class_group_members")
    .select("student_id")
    .in("class_group_id", groupIds);
  for (const m of members ?? []) out.myStudentIds.add(m.student_id as string);
  if (out.myStudentIds.size === 0) return out;

  const { data: studentSubs } = await db
    .from("submissions")
    .select("test_id")
    .in("student_id", Array.from(out.myStudentIds));
  for (const s of studentSubs ?? []) {
    out.classTestIds.add(s.test_id as string);
  }
  return out;
}

