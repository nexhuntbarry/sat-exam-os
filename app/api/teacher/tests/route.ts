import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestScope, seesAllStudents } from "@/lib/teacher-access";
import { getQaUserIds, onSide, scopeIds } from "@/lib/qa";

// GET /api/teacher/tests
export async function GET() {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const db = getServiceClient();

  // Visible tests = direct assignment ∪ tests reaching the teacher via
  // their classes (assigned to the class / its students, or taken by
  // them), subject-scoped. Shared with My Tests and the dashboard.
  let scope;
  try {
    scope = await getTeacherTestScope(db, user);
  } catch (err) {
    console.error("[teacher/tests/get scope]", err);
    return NextResponse.json({ error: "Failed to fetch assignments" }, { status: 500 });
  }
  if (scope.testIds.size === 0) {
    return NextResponse.json({ data: [] });
  }

  const testIds = Array.from(scope.testIds);

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

  const { data: assignments, error: assignError } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids")
    .in("test_id", testIds);
  if (assignError) {
    console.error("[teacher/tests/get assignments]", assignError);
    return NextResponse.json({ error: "Failed to fetch assignments" }, { status: 500 });
  }
  const assignMap: Record<string, { student_ids: string[]; class_group_ids: string[] }> = {};
  for (const a of assignments ?? []) {
    assignMap[a.test_id as string] = {
      student_ids: (a.student_ids as string[] | null) ?? [],
      class_group_ids: (a.class_group_ids as string[] | null) ?? [],
    };
  }

  // Roster per test = student_ids ∪ class_group members, limited to my
  // students unless I see the whole test.
  const groupIds = Array.from(
    new Set(Object.values(assignMap).flatMap((a) => a.class_group_ids)),
  );
  const membersByGroup = new Map<string, string[]>();
  if (groupIds.length > 0) {
    const { data: members, error: memberError } = await db
      .from("class_group_members")
      .select("class_group_id, student_id")
      .in("class_group_id", groupIds);
    if (memberError) {
      console.error("[teacher/tests/get members]", memberError);
      return NextResponse.json({ error: "Failed to fetch assignments" }, { status: 500 });
    }
    for (const m of members ?? []) {
      const list = membersByGroup.get(m.class_group_id as string) ?? [];
      list.push(m.student_id as string);
      membersByGroup.set(m.class_group_id as string, list);
    }
  }
  const qaUsers = await getQaUserIds();

  // Submission counts: one per attempt (two-module attempts share a
  // session_id), only my class students unless I see the whole test.
  const { data: subData, error: subError } = await scopeIds(db
    .from("submissions")
    .select("id, test_id, student_id, status, correct_count, total_questions, percentage, session_id")
    .in("test_id", testIds), "student_id", qaUsers, user.isQa);
  if (subError) {
    console.error("[teacher/tests/get submissions]", subError);
    return NextResponse.json({ error: "Failed to fetch submissions" }, { status: 500 });
  }

  type SubRow = {
    id: string;
    test_id: string;
    student_id: string;
    status: string;
    correct_count: number | null;
    total_questions: number | null;
    percentage: number | string | null;
    session_id: string | null;
  };
  const attemptsByTest = new Map<string, Map<string, SubRow[]>>();
  for (const s of (subData ?? []) as SubRow[]) {
    if (!seesAllStudents(scope, s.test_id) && !scope.myStudentIds.has(s.student_id)) continue;
    const attempts = attemptsByTest.get(s.test_id) ?? new Map<string, SubRow[]>();
    const key = s.session_id ?? s.id;
    attempts.set(key, [...(attempts.get(key) ?? []), s]);
    attemptsByTest.set(s.test_id, attempts);
  }

  const enriched = (tests ?? []).map((t) => {
    const assign = assignMap[t.id] ?? { student_ids: [], class_group_ids: [] };
    const all = seesAllStudents(scope, t.id);
    const roster = new Set<string>();
    for (const sid of [
      ...assign.student_ids,
      ...assign.class_group_ids.flatMap((g) => membersByGroup.get(g) ?? []),
    ]) {
      if (!onSide(sid, qaUsers, user.isQa)) continue;
      if (all || scope.myStudentIds.has(sid)) roster.add(sid);
    }
    let submittedCount = 0;
    const pcts: number[] = [];
    for (const rows of (attemptsByTest.get(t.id) ?? new Map<string, SubRow[]>()).values()) {
      if (!rows.every((r) => r.status === "Submitted" || r.status === "Late")) continue;
      submittedCount++;
      const correct = rows.reduce((n, r) => n + (r.correct_count ?? 0), 0);
      const total = rows.reduce((n, r) => n + (r.total_questions ?? 0), 0);
      if (total > 0) pcts.push((correct / total) * 100);
      else if (rows[0].percentage != null) pcts.push(Number(rows[0].percentage));
    }
    const avgScore = pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
    return {
      ...t,
      // Don't expose other classes' rosters to a class-scoped teacher.
      assignment: all
        ? assign
        : {
            student_ids: assign.student_ids.filter((sid) => scope.myStudentIds.has(sid)),
            class_group_ids: assign.class_group_ids.filter((g) => scope.myGroupIds.has(g)),
          },
      submittedCount,
      totalStudents: roster.size,
      avgScore,
    };
  });

  return NextResponse.json({ data: enriched });
}
