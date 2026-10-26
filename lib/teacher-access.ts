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
import { getQaTestIds, getQaUserIds, onSide } from "./qa";

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
  user: { userId: string; role: string | null | undefined; isQa: boolean },
  testId: string,
): Promise<TeacherTestAccess> {
  // QA isolation: a test from the other side is invisible to everyone.
  if (!onSide(testId, await getQaTestIds(), user.isQa)) {
    return { mode: null, studentAllowlist: null };
  }
  if (user.role === "admin") {
    return { mode: "admin", studentAllowlist: null };
  }

  // Class teacher takes PRECEDENCE over a direct teacher_ids assignment.
  // A teacher attached to a class is always scoped to their subject and to
  // their class's students — even if they also appear in teacher_ids —
  // otherwise an English teacher who happens to be on teacher_ids would see
  // Math tests and students outside their class. Only a pure reviewer (on
  // teacher_ids but NOT a class teacher) gets full "direct" access.
  const { data: myGroups } = await db
    .from("class_group_teachers")
    .select("class_group_id, subject")
    .eq("teacher_id", user.userId);
  const rows = myGroups ?? [];

  if (rows.length > 0) {
    // Subject gate: if every class row is pinned to a specific subject and
    // none matches this test's subject, deny. NULL subject ("both") lifts it.
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
    const qaUsers = await getQaUserIds();
    const allowlist = new Set(
      (members ?? [])
        .map((m) => m.student_id as string)
        .filter((id) => onSide(id, qaUsers, user.isQa)),
    );
    if (allowlist.size === 0) return { mode: null, studentAllowlist: null };
    return { mode: "class", studentAllowlist: allowlist };
  }

  // Not a class teacher → full access only if directly assigned.
  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids")
    .eq("test_id", testId)
    .maybeSingle();
  const teacherIds = (assignment?.teacher_ids as string[] | null) ?? [];
  if (teacherIds.includes(user.userId)) {
    return { mode: "direct", studentAllowlist: null };
  }
  return { mode: null, studentAllowlist: null };
}

export interface TeacherTestScope {
  /**
   * Tests the teacher is on test_assignments.teacher_ids for (for a class
   * teacher, only those in a subject they teach).
   */
  directTestIds: Set<string>;
  /**
   * Tests reaching the teacher through their classes: assigned to one of
   * their class_groups (class_group_ids), assigned to one of their
   * students individually (student_ids), or taken by one of their
   * students — each kept only when the subject matches what the teacher
   * teaches in that class.
   */
  classTestIds: Set<string>;
  /** directTestIds ∪ classTestIds (every test for admin). QA-filtered. */
  testIds: Set<string>;
  /**
   * Every student in the teacher's class_groups. Used to scope
   * cohort/skill analytics queries.
   */
  myStudentIds: Set<string>;
  /** The teacher's class_group ids (class_group_teachers). */
  myGroupIds: Set<string>;
  /**
   * True when the teacher has any class_group_teachers row. Class teachers
   * are always student-scoped, even on tests they're on teacher_ids for
   * (matches getTeacherTestAccess).
   */
  isClassTeacher: boolean;
  /** admin → full unrestricted scope (callers should bypass filters). */
  isAdmin: boolean;
}

/**
 * Whether the caller sees every student's submissions on this test
 * (admin, or a pure reviewer on teacher_ids) rather than only their own
 * class students. Mirrors getTeacherTestAccess "admin" / "direct" modes.
 */
export function seesAllStudents(scope: TeacherTestScope, testId: string): boolean {
  if (scope.isAdmin) return true;
  return !scope.isClassTeacher && scope.directTestIds.has(testId);
}

// Single source of truth for "which tests does this teacher see" — used by
// My Tests, the dashboard, /teacher/results and /api/teacher/tests.
// test_assignments.{teacher_ids,class_group_ids,student_ids} are jsonb, so
// the array filters run in JS (the table is small) instead of PostgREST
// .overlaps(), which fails on jsonb ("operator does not exist: jsonb && …").
export async function getTeacherTestScope(
  db: SupabaseClient,
  user: { userId: string; role: string | null | undefined; isQa: boolean },
): Promise<TeacherTestScope> {
  const out: TeacherTestScope = {
    directTestIds: new Set(),
    classTestIds: new Set(),
    testIds: new Set(),
    myStudentIds: new Set(),
    myGroupIds: new Set(),
    isClassTeacher: false,
    isAdmin: user.role === "admin",
  };
  const [qaTests, qaUsers] = await Promise.all([getQaTestIds(), getQaUserIds()]);

  const { data: assignments, error: assignError } = await db
    .from("test_assignments")
    .select("test_id, teacher_ids, student_ids, class_group_ids");
  if (assignError) throw new Error(`test_assignments lookup failed: ${assignError.message}`);
  const onMySide = (assignments ?? []).filter((a) =>
    onSide(a.test_id as string, qaTests, user.isQa),
  );

  if (out.isAdmin) {
    for (const a of onMySide) out.testIds.add(a.test_id as string);
    return out;
  }

  const { data: myGroups, error: groupError } = await db
    .from("class_group_teachers")
    .select("class_group_id, subject")
    .eq("teacher_id", user.userId);
  if (groupError) throw new Error(`class_group_teachers lookup failed: ${groupError.message}`);
  const groupRows = myGroups ?? [];
  out.isClassTeacher = groupRows.length > 0;
  // group → subject it's taught in (NULL = both subjects)
  const subjectOfGroup = new Map<string, string | null>();
  for (const g of groupRows) {
    out.myGroupIds.add(g.class_group_id as string);
    subjectOfGroup.set(g.class_group_id as string, (g.subject as string | null) ?? null);
  }

  // student → subjects the teacher teaches them (via the student's groups)
  const subjectsOfStudent = new Map<string, (string | null)[]>();
  if (out.myGroupIds.size > 0) {
    const { data: members, error: memberError } = await db
      .from("class_group_members")
      .select("class_group_id, student_id")
      .in("class_group_id", Array.from(out.myGroupIds));
    if (memberError) throw new Error(`class_group_members lookup failed: ${memberError.message}`);
    for (const m of members ?? []) {
      const sid = m.student_id as string;
      if (!onSide(sid, qaUsers, user.isQa)) continue;
      out.myStudentIds.add(sid);
      const list = subjectsOfStudent.get(sid) ?? [];
      list.push(subjectOfGroup.get(m.class_group_id as string) ?? null);
      subjectsOfStudent.set(sid, list);
    }
  }

  // Candidate test → subjects under which it reaches the teacher.
  // Direct assignment counts under any of the teacher's subjects (a pure
  // reviewer with no classes has none, which lifts the subject filter).
  const allSubjects = Array.from(subjectOfGroup.values());
  const candidates = new Map<string, { direct: boolean; subjects: (string | null)[] }>();
  const add = (testId: string, subjects: (string | null)[], direct = false) => {
    const c = candidates.get(testId) ?? { direct: false, subjects: [] };
    c.direct ||= direct;
    c.subjects.push(...subjects);
    candidates.set(testId, c);
  };
  for (const a of onMySide) {
    const testId = a.test_id as string;
    if (((a.teacher_ids as string[] | null) ?? []).includes(user.userId)) {
      add(testId, out.isClassTeacher ? allSubjects : [null], true);
    }
    for (const gid of (a.class_group_ids as string[] | null) ?? []) {
      if (subjectOfGroup.has(gid)) add(testId, [subjectOfGroup.get(gid) ?? null]);
    }
    for (const sid of (a.student_ids as string[] | null) ?? []) {
      const subs = subjectsOfStudent.get(sid);
      if (subs) add(testId, subs);
    }
  }

  // Tests any of my students actually took (covers legacy assignments).
  if (out.myStudentIds.size > 0) {
    const { data: studentSubs, error: subError } = await db
      .from("submissions")
      .select("test_id, student_id")
      .in("student_id", Array.from(out.myStudentIds));
    if (subError) throw new Error(`submissions lookup failed: ${subError.message}`);
    for (const s of studentSubs ?? []) {
      if (!onSide(s.test_id as string, qaTests, user.isQa)) continue;
      add(s.test_id as string, subjectsOfStudent.get(s.student_id as string) ?? []);
    }
  }

  const sections = await getTestSections(db, Array.from(candidates.keys()));
  for (const [testId, c] of candidates) {
    const sec = sections.get(testId) ?? null;
    if (sec && !c.subjects.some((s) => !s || s === sec)) continue;
    out.testIds.add(testId);
    if (c.direct) out.directTestIds.add(testId);
    else out.classTestIds.add(testId);
  }
  return out;
}

/**
 * Students a test is assigned to: student_ids ∪ members of class_group_ids.
 * QA-filtered to the viewer's side. Pass `allowlist` (a class teacher's
 * roster) to keep only students the caller teaches.
 */
export async function getAssignedStudentIds(
  db: SupabaseClient,
  assignment: { student_ids?: unknown; class_group_ids?: unknown } | null,
  viewerIsQa: boolean,
  allowlist: Set<string> | null = null,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!assignment) return out;
  const groupIds = (assignment.class_group_ids as string[] | null) ?? [];
  const ids = [...((assignment.student_ids as string[] | null) ?? [])];
  if (groupIds.length > 0) {
    const { data: members, error } = await db
      .from("class_group_members")
      .select("student_id")
      .in("class_group_id", groupIds);
    if (error) throw new Error(`class_group_members lookup failed: ${error.message}`);
    for (const m of members ?? []) ids.push(m.student_id as string);
  }
  const qaUsers = await getQaUserIds();
  for (const id of ids) {
    if (!onSide(id, qaUsers, viewerIsQa)) continue;
    if (allowlist && !allowlist.has(id)) continue;
    out.add(id);
  }
  return out;
}

/**
 * Test-wide settings (answer visibility, class-review unlock) live on the
 * tests row and affect every class the test is assigned to, so only an
 * admin or the test's owner — on test_assignments.teacher_ids, or its
 * creator — may change them. A class teacher who merely teaches one of the
 * assigned classes may not.
 */
export async function canManageTestSettings(
  db: SupabaseClient,
  user: { userId: string; role: string | null | undefined; isQa: boolean },
  testId: string,
): Promise<boolean> {
  if (!onSide(testId, await getQaTestIds(), user.isQa)) return false;
  if (user.role === "admin") return true;
  const [{ data: assignment }, { data: test }] = await Promise.all([
    db.from("test_assignments").select("teacher_ids").eq("test_id", testId).maybeSingle(),
    db.from("tests").select("created_by").eq("id", testId).maybeSingle(),
  ]);
  const teacherIds = (assignment?.teacher_ids as string[] | null) ?? [];
  return teacherIds.includes(user.userId) || test?.created_by === user.userId;
}

/**
 * Subjects a teacher teaches a given student (via class_group_teachers rows
 * for groups the student is in; optionally just one group). Returns
 * `{ teaches: false }` when the teacher has no class with the student, and
 * `subjects: null` when any matching row is subject-less ("both").
 */
export async function getTeacherSubjectsForStudent(
  db: SupabaseClient,
  teacherId: string,
  studentId: string,
  classGroupId?: string,
): Promise<{ teaches: boolean; subjects: string[] | null }> {
  let teacherQuery = db
    .from("class_group_teachers")
    .select("class_group_id, subject")
    .eq("teacher_id", teacherId);
  if (classGroupId) teacherQuery = teacherQuery.eq("class_group_id", classGroupId);
  const { data: rows, error } = await teacherQuery;
  if (error) throw new Error(`class_group_teachers lookup failed: ${error.message}`);
  const groupIds = (rows ?? []).map((r) => r.class_group_id as string);
  if (groupIds.length === 0) return { teaches: false, subjects: [] };
  const { data: memberships, error: memberError } = await db
    .from("class_group_members")
    .select("class_group_id")
    .eq("student_id", studentId)
    .in("class_group_id", groupIds);
  if (memberError) throw new Error(`class_group_members lookup failed: ${memberError.message}`);
  const shared = new Set((memberships ?? []).map((m) => m.class_group_id as string));
  const subjects = (rows ?? [])
    .filter((r) => shared.has(r.class_group_id as string))
    .map((r) => (r.subject as string | null) ?? null);
  if (subjects.length === 0) return { teaches: false, subjects: [] };
  if (subjects.some((s) => !s)) return { teaches: true, subjects: null };
  return { teaches: true, subjects: subjects as string[] };
}

/** Keep items whose section is one of `subjects` (null = keep everything). */
export function inSubjects(section: string | null | undefined, subjects: string[] | null): boolean {
  return subjects === null || (!!section && subjects.includes(section));
}

/**
 * Tests assigned to a student: test_assignments listing them in student_ids
 * or any of their class groups in class_group_ids. QA-filtered.
 */
export async function getStudentAssignedTestIds(
  db: SupabaseClient,
  studentId: string,
  viewerIsQa: boolean,
): Promise<Set<string>> {
  const [{ data: memberships, error: memberError }, { data: assignments, error: assignError }] =
    await Promise.all([
      db.from("class_group_members").select("class_group_id").eq("student_id", studentId),
      db.from("test_assignments").select("test_id, student_ids, class_group_ids"),
    ]);
  if (memberError) throw new Error(`class_group_members lookup failed: ${memberError.message}`);
  if (assignError) throw new Error(`test_assignments lookup failed: ${assignError.message}`);
  const groups = new Set((memberships ?? []).map((m) => m.class_group_id as string));
  const qaTests = await getQaTestIds();
  const out = new Set<string>();
  for (const a of assignments ?? []) {
    const testId = a.test_id as string;
    if (!onSide(testId, qaTests, viewerIsQa)) continue;
    if (
      ((a.student_ids as string[] | null) ?? []).includes(studentId) ||
      ((a.class_group_ids as string[] | null) ?? []).some((g) => groups.has(g))
    ) {
      out.add(testId);
    }
  }
  return out;
}
