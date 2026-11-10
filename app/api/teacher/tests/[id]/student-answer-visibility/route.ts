import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { expandFullLength } from "@/lib/full-length";
import { forbidCrossSide } from "@/lib/qa";
import { canManageTestSettings, getAssignedStudentIds } from "@/lib/teacher-access";
import {
  STUDENT_ANSWER_MODES,
  loadAnswerVisibilityInputs,
  summarizeAnswerVisibility,
  visibilityKey,
  type StudentAnswerMode,
} from "@/lib/answer-visibility";

// POST /api/teacher/tests/[id]/student-answer-visibility
// Body: { studentId: string; mode: "follow" | "show" | "hide"; showExplanations?: boolean }
//
// Per-student override of answer visibility for one test. Same permission
// as the test-level toggle (answer-visibility): an admin, or the test's
// owning teacher. Every change is written to student_answer_visibility_log
// with who/when, like retake grants record granted_by/granted_at.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId } = await params;
  let body: { studentId?: unknown; mode?: unknown; showExplanations?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const studentId = typeof body.studentId === "string" ? body.studentId : "";
  if (!studentId) {
    return NextResponse.json({ error: "studentId is required" }, { status: 400 });
  }
  if (!STUDENT_ANSWER_MODES.includes(body.mode as StudentAnswerMode)) {
    return NextResponse.json({ error: "mode must be follow, show or hide" }, { status: 400 });
  }
  const mode = body.mode as StudentAnswerMode;
  if (body.showExplanations !== undefined && typeof body.showExplanations !== "boolean") {
    return NextResponse.json({ error: "showExplanations must be a boolean" }, { status: 400 });
  }
  const showExplanations = body.showExplanations !== false;

  const crossSide = await forbidCrossSide(user, { testIds: [testId], userIds: [studentId] });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  if (!(await canManageTestSettings(db, user, testId))) {
    return NextResponse.json(
      { error: "Only the test's owner or an admin can change answer visibility" },
      { status: 403 },
    );
  }

  const { data: student } = await db
    .from("users")
    .select("id")
    .eq("id", studentId)
    .eq("role", "student")
    .maybeSingle();
  if (!student) {
    return NextResponse.json({ error: "Student not found" }, { status: 400 });
  }

  // Only students who can see the test (individually or via a class), or
  // who already have a submission on it (e.g. later removed from the class).
  const [{ data: assignment }, { data: anySub }] = await Promise.all([
    db.from("test_assignments").select("student_ids, class_group_ids").eq("test_id", testId).maybeSingle(),
    // (a full-length SAT's submissions are on its section children)
    db.from("submissions").select("id").in("test_id", await expandFullLength(db, [testId])).eq("student_id", studentId).limit(1),
  ]);
  const assigned = await getAssignedStudentIds(db, assignment, user.isQa);
  if (!assigned.has(studentId) && (anySub ?? []).length === 0) {
    return NextResponse.json(
      { error: "This student is not assigned to this test" },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const { error: upsertErr } = await db.from("student_answer_visibility").upsert(
    {
      test_id: testId,
      student_id: studentId,
      mode,
      show_explanations: showExplanations,
      updated_by: user.userId,
      updated_at: now,
    },
    { onConflict: "test_id,student_id" },
  );
  if (upsertErr) {
    console.error("[teacher/student-answer-visibility] upsert", upsertErr);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }

  const { error: logErr } = await db.from("student_answer_visibility_log").insert({
    test_id: testId,
    student_id: studentId,
    mode,
    show_explanations: showExplanations,
    changed_by: user.userId,
    changed_at: now,
  });
  if (logErr) {
    // The setting is saved; surface the audit failure rather than hide it.
    console.error("[teacher/student-answer-visibility] log", logErr);
    return NextResponse.json({ error: "Saved, but the change log failed to record" }, { status: 500 });
  }

  const inputs = await loadAnswerVisibilityInputs(db, [testId], [studentId]);
  const input = inputs.get(visibilityKey(testId, studentId));
  return NextResponse.json({
    ok: true,
    mode,
    showExplanations,
    effective: input ? summarizeAnswerVisibility(input) : null,
  });
}
