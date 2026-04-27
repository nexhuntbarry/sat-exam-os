import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/teacher/teaching-mode/test-review?testId=optional
// Returns the latest (or specified) published/closed test that the teacher's
// classes took, plus the top 5 hardest questions by error_rate for that test
// + the list of all tests the teacher has assigned (for the picker).
export async function GET(req: Request) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { searchParams } = new URL(req.url);
  const requestedTestId = searchParams.get("testId");

  const db = getServiceClient();

  const { data: assignments } = await db
    .from("test_assignments")
    .select("test_id")
    .contains("teacher_ids", JSON.stringify([user.userId]));

  if (!assignments || assignments.length === 0) {
    return NextResponse.json({
      tests: [],
      selectedTest: null,
      hardestQuestions: [],
      totalSubmissions: 0,
    });
  }

  const testIds = assignments.map((a) => a.test_id);

  // List of tests teacher's classes have access to — for the dropdown
  const { data: tests } = await db
    .from("tests")
    .select("id, test_name, status, created_at")
    .in("id", testIds)
    .in("status", ["Published", "Closed"])
    .order("created_at", { ascending: false });

  if (!tests || tests.length === 0) {
    return NextResponse.json({
      tests: [],
      selectedTest: null,
      hardestQuestions: [],
      totalSubmissions: 0,
    });
  }

  // Pick selected test (requested first, otherwise latest with submissions)
  let selected = requestedTestId ? tests.find((t) => t.id === requestedTestId) : null;
  if (!selected) selected = tests[0];

  // Find submissions for selected test
  const { data: submissions } = await db
    .from("submissions")
    .select("id")
    .eq("test_id", selected.id)
    .in("status", ["Submitted", "Late"]);

  const subIds = (submissions ?? []).map((s) => s.id);
  const totalSubmissions = subIds.length;

  if (totalSubmissions === 0) {
    return NextResponse.json({
      tests: tests.map((t) => ({ id: t.id, test_name: t.test_name, status: t.status })),
      selectedTest: { id: selected.id, test_name: selected.test_name, status: selected.status },
      hardestQuestions: [],
      totalSubmissions: 0,
    });
  }

  // Aggregate per question
  const { data: ars } = await db
    .from("answer_records")
    .select("question_id, student_answer, is_correct")
    .in("submission_id", subIds);

  const perQ = new Map<string, { total: number; wrong: number }>();
  for (const ar of ars ?? []) {
    let e = perQ.get(ar.question_id);
    if (!e) {
      e = { total: 0, wrong: 0 };
      perQ.set(ar.question_id, e);
    }
    e.total++;
    if (!ar.is_correct) e.wrong++;
  }

  const ranked = Array.from(perQ.entries())
    .map(([qid, v]) => ({
      questionId: qid,
      total: v.total,
      wrong: v.wrong,
      errorRate: v.total > 0 ? (v.wrong / v.total) * 100 : 0,
    }))
    .sort((a, b) => b.errorRate - a.errorRate)
    .slice(0, 5);

  const qIds = ranked.map((r) => r.questionId);
  const { data: qmeta } = qIds.length
    ? await db
        .from("questions")
        .select("id, original_question_number, question_text, domain, skill, difficulty")
        .in("id", qIds)
    : { data: [] };

  const metaMap = new Map((qmeta ?? []).map((q) => [q.id, q]));

  const hardestQuestions = ranked.map((r) => {
    const m = metaMap.get(r.questionId);
    return {
      questionId: r.questionId,
      questionNumber: m?.original_question_number ?? null,
      questionText: m?.question_text ?? "",
      domain: m?.domain ?? null,
      skill: m?.skill ?? null,
      difficulty: m?.difficulty ?? null,
      totalAnswered: r.total,
      wrongCount: r.wrong,
      errorRate: r.errorRate,
    };
  });

  return NextResponse.json({
    tests: tests.map((t) => ({ id: t.id, test_name: t.test_name, status: t.status })),
    selectedTest: { id: selected.id, test_name: selected.test_name, status: selected.status },
    hardestQuestions,
    totalSubmissions,
  });
}
