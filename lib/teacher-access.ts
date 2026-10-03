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

// A test's subject is the section ("Math" | "Reading & Writing") of its
// module (module_1_id for adaptive tests). Used to scope class teachers to
// the subject they teach.
export async function getTestSection(
  db: SupabaseClient,
  testId: string,
): Promise<string | null> {
  const { data: test } = await db
    .from("tests")
    .select("module_id, module_1_id")
    .eq("id", testId)
    .maybeSingle();
  if (!test) return null;
  const moduleId =
    (test.module_id as string | null) ?? (test.module_1_id as string | null);
  if (!moduleId) return null;
  const { data: mod } = await db
    .from("modules")
    .select("section")
    .eq("id", moduleId)
    .maybeSingle();
  return (mod?.section as string | null) ?? null;
}

// Batch version: testId → section, for filtering a set of tests at once.
export async function getTestSections(
  db: SupabaseClient,
  testIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (testIds.length === 0) return out;
  const { data: tests } = await db
    .from("tests")
    .select("id, module_id, module_1_id")
    .in("id", testIds);
  const moduleOf = new Map<string, string | null>();
  const moduleIds = new Set<string>();
  for (const t of tests ?? []) {
    const m = (t.module_id as string | null) ?? (t.module_1_id as string | null);
    moduleOf.set(t.id as string, m);
    if (m) moduleIds.add(m);
  }
  const { data: mods } = moduleIds.size
    ? await db.from("modules").select("id, section").in("id", Array.from(moduleIds))
    : { data: [] as { id: string; section: string | null }[] };
  const sectionOf = new Map((mods ?? []).map((m) => [m.id as string, m.section as string | null]));
  for (const [testId, m] of moduleOf) out.set(testId, m ? sectionOf.get(m) ?? null : null);
  return out;
}

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

  // Class-group fallback, subject-scoped.
  const { data: myGroups } = await db
    .from("class_group_teachers")
    .select("class_group_id, subject")
    .eq("teacher_id", user.userId);
  const rows = myGroups ?? [];
  if (rows.length === 0) return { mode: null, studentAllowlist: null };

  // Subject gate: if the teacher's class rows are all pinned to specific
  // subjects and none matches this test's subject, deny. A NULL subject
  // ("both") lifts the gate.
  const subjects = rows.map((r) => (r.subject as string | null) ?? null);
  const allowAll = subjects.some((s) => !s);
  if (!allowAll) {
    const section = await getTestSection(db, testId);
    if (section && !subjects.includes(section)) {
      return { mode: null, studentAllowlist: null };
    }
  }

  const groupIds = rows.map((r) => r.class_group_id as string);
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
    .select("class_group_id, subject")
    .eq("teacher_id", user.userId);
  const rows = myGroups ?? [];
  const groupIds = rows.map((g) => g.class_group_id as string);
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
  const classTestIds = new Set<string>();
  for (const s of studentSubs ?? []) classTestIds.add(s.test_id as string);

  // Subject scoping: keep only tests whose subject the teacher teaches.
  // A NULL subject on any class row means "both" and lifts the filter.
  const subjects = rows.map((r) => (r.subject as string | null) ?? null);
  const allowAll = subjects.some((s) => !s);
  if (allowAll) {
    for (const id of classTestIds) out.classTestIds.add(id);
  } else {
    const sections = await getTestSections(db, Array.from(classTestIds));
    for (const id of classTestIds) {
      const sec = sections.get(id) ?? null;
      if (!sec || subjects.includes(sec)) out.classTestIds.add(id);
    }
  }
  return out;
}

