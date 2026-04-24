import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/teacher/tests
export async function GET() {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const db = getServiceClient();

  // Find assignments where this teacher is in teacher_ids
  const { data: assignments, error: assignError } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids")
    .contains("teacher_ids", JSON.stringify([user.userId]));

  if (assignError) {
    console.error("[teacher/tests/get]", assignError);
    return NextResponse.json({ error: "Failed to fetch assignments" }, { status: 500 });
  }

  if (!assignments || assignments.length === 0) {
    return NextResponse.json({ data: [] });
  }

  const testIds = assignments.map((a) => a.test_id);

  const { data: tests, error: testsError } = await db
    .from("tests")
    .select(`
      id, test_name, module_id, time_limit_minutes, open_date, due_date,
      show_answers_after_submission, allow_retake, status, created_at,
      modules!inner(module_name, section, module_number)
    `)
    .in("id", testIds)
    .order("created_at", { ascending: false });

  if (testsError) {
    console.error("[teacher/tests/get tests]", testsError);
    return NextResponse.json({ error: "Failed to fetch tests" }, { status: 500 });
  }

  // Build assignment map
  const assignMap: Record<string, { student_ids: string[]; class_group_ids: string[] }> = {};
  for (const a of assignments) {
    assignMap[a.test_id] = {
      student_ids: a.student_ids ?? [],
      class_group_ids: a.class_group_ids ?? [],
    };
  }

  // Get submission counts
  const { data: subData } = await db
    .from("submissions")
    .select("test_id, status, score")
    .in("test_id", testIds);

  const subMap: Record<string, { total: number; done: number; scores: number[] }> = {};
  for (const s of subData ?? []) {
    if (!subMap[s.test_id]) subMap[s.test_id] = { total: 0, done: 0, scores: [] };
    subMap[s.test_id].total++;
    if (s.status === "Submitted" || s.status === "Late") {
      subMap[s.test_id].done++;
      if (s.score != null) subMap[s.test_id].scores.push(Number(s.score));
    }
  }

  const enriched = (tests ?? []).map((t) => {
    const assign = assignMap[t.id] ?? { student_ids: [], class_group_ids: [] };
    const subs = subMap[t.id] ?? { total: 0, done: 0, scores: [] };
    const avgScore = subs.scores.length > 0 ? subs.scores.reduce((a, b) => a + b, 0) / subs.scores.length : null;
    return {
      ...t,
      assignment: assign,
      submittedCount: subs.done,
      totalStudents: assign.student_ids.length,
      avgScore,
    };
  });

  return NextResponse.json({ data: enriched });
}
