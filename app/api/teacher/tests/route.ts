import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/teacher/tests
export async function GET() {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const db = getServiceClient();

  // Visible tests for this teacher = direct assignment ∪ "my class
  // students took it". teacher_ids is no longer required.
  const directTestIds = new Set<string>();
  const myStudentIds = new Set<string>();
  const directAssignments: Array<{
    test_id: string;
    student_ids: string[] | null;
    class_group_ids: string[] | null;
  }> = [];

  if (user.role === "admin") {
    const { data: all, error } = await db
      .from("test_assignments")
      .select("test_id, student_ids, class_group_ids");
    if (error) {
      console.error("[teacher/tests/get admin]", error);
      return NextResponse.json({ error: "Failed to fetch assignments" }, { status: 500 });
    }
    for (const a of all ?? []) {
      directTestIds.add(a.test_id as string);
      directAssignments.push({
        test_id: a.test_id as string,
        student_ids: (a.student_ids as string[] | null) ?? [],
        class_group_ids: (a.class_group_ids as string[] | null) ?? [],
      });
    }
  } else {
    const { data: directly, error: assignError } = await db
      .from("test_assignments")
      .select("test_id, student_ids, class_group_ids")
      .contains("teacher_ids", JSON.stringify([user.userId]));
    if (assignError) {
      console.error("[teacher/tests/get]", assignError);
      return NextResponse.json({ error: "Failed to fetch assignments" }, { status: 500 });
    }
    for (const a of directly ?? []) {
      directTestIds.add(a.test_id as string);
      directAssignments.push({
        test_id: a.test_id as string,
        student_ids: (a.student_ids as string[] | null) ?? [],
        class_group_ids: (a.class_group_ids as string[] | null) ?? [],
      });
    }

    const { data: myGroups } = await db
      .from("class_group_teachers")
      .select("class_group_id")
      .eq("teacher_id", user.userId);
    const groupIds = (myGroups ?? []).map((g) => g.class_group_id as string);
    if (groupIds.length > 0) {
      const { data: members } = await db
        .from("class_group_members")
        .select("student_id")
        .in("class_group_id", groupIds);
      for (const m of members ?? []) myStudentIds.add(m.student_id as string);
    }
  }

  // Pull every test_id where any of my class students have a
  // submission (for the non-admin class path). Union with direct.
  const indirectTestIds = new Set<string>();
  if (user.role !== "admin" && myStudentIds.size > 0) {
    const { data: studentSubs } = await db
      .from("submissions")
      .select("test_id")
      .in("student_id", Array.from(myStudentIds));
    for (const s of studentSubs ?? []) indirectTestIds.add(s.test_id as string);
  }

  const allVisibleTestIds = new Set<string>([
    ...Array.from(directTestIds),
    ...Array.from(indirectTestIds),
  ]);
  if (allVisibleTestIds.size === 0) {
    return NextResponse.json({ data: [] });
  }

  const testIds = Array.from(allVisibleTestIds);

  const { data: tests, error: testsError } = await db
    .from("tests")
    .select(`
      id, test_name, module_id, time_limit_minutes, open_date, due_date,
      show_answers_after_submission, allow_retake, status, created_at,
      modules!module_id(module_name, section, module_number)
    `)
    .in("id", testIds)
    .order("created_at", { ascending: false });

  if (testsError) {
    console.error("[teacher/tests/get tests]", testsError);
    return NextResponse.json({ error: "Failed to fetch tests" }, { status: 500 });
  }

  // Build assignment map from direct assignments only. Class-derived
  // tests get an empty assignment shell so the UI still has the shape.
  const assignMap: Record<string, { student_ids: string[]; class_group_ids: string[] }> = {};
  for (const a of directAssignments) {
    assignMap[a.test_id] = {
      student_ids: a.student_ids ?? [],
      class_group_ids: a.class_group_ids ?? [],
    };
  }

  // Submission counts scoped per visibility track. Direct tests count
  // every submission (legacy global view); class-derived tests count
  // only my class students.
  let submissionQuery = db
    .from("submissions")
    .select("test_id, student_id, status, score")
    .in("test_id", testIds);
  const { data: subData } = await submissionQuery;

  const subMap: Record<string, { total: number; done: number; scores: number[]; students: Set<string> }> = {};
  for (const s of subData ?? []) {
    const tid = s.test_id as string;
    const sid = s.student_id as string;
    const isDirect = directTestIds.has(tid);
    if (!isDirect && !myStudentIds.has(sid)) continue; // class-scoped guard
    const slot = (subMap[tid] ??= { total: 0, done: 0, scores: [], students: new Set() });
    slot.total++;
    slot.students.add(sid);
    if (s.status === "Submitted" || s.status === "Late") {
      slot.done++;
      if (s.score != null) slot.scores.push(Number(s.score));
    }
  }

  const enriched = (tests ?? []).map((t) => {
    const assign = assignMap[t.id] ?? { student_ids: [], class_group_ids: [] };
    const subs = subMap[t.id] ?? { total: 0, done: 0, scores: [], students: new Set() };
    const avgScore = subs.scores.length > 0 ? subs.scores.reduce((a, b) => a + b, 0) / subs.scores.length : null;
    const isDirect = directTestIds.has(t.id);
    // For class-scoped (indirect) tests, the "total students" we count
    // = students of mine who have a submission on this test. For
    // direct assignment, fall back to assignment.student_ids.length.
    const totalStudents = isDirect ? assign.student_ids.length : subs.students.size;
    return {
      ...t,
      assignment: assign,
      submittedCount: subs.done,
      totalStudents,
      avgScore,
    };
  });
  void submissionQuery;

  return NextResponse.json({ data: enriched });
}
