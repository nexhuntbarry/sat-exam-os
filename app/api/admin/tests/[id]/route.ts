import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/admin/tests/[id]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data: test, error } = await db
    .from("tests")
    .select(`
      id, test_name, module_id, time_limit_minutes, open_date, due_date,
      show_answers_after_submission, allow_retake, status, question_ids,
      created_by, created_at, updated_at,
      modules!inner(module_name, section, module_number, source_name)
    `)
    .eq("id", id)
    .single();

  if (error || !test) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }

  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids, student_ids, class_group_ids")
    .eq("test_id", id)
    .single();

  const { data: submissions } = await db
    .from("submissions")
    .select("id, student_id, status, score, correct_count, total_questions, percentage, started_at, submitted_at, time_spent_seconds, attempt_number")
    .eq("test_id", id)
    .order("submitted_at", { ascending: false });

  return NextResponse.json({
    data: {
      ...test,
      assignment: assignment ?? { teacher_ids: [], student_ids: [], class_group_ids: [] },
      submissions: submissions ?? [],
    },
  });
}

// PATCH /api/admin/tests/[id]
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const db = getServiceClient();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.testName !== undefined) updates.test_name = String(body.testName).trim();
  if (body.timeLimitMinutes !== undefined) updates.time_limit_minutes = body.timeLimitMinutes;
  if (body.openDate !== undefined) updates.open_date = body.openDate;
  if (body.dueDate !== undefined) updates.due_date = body.dueDate;
  if (body.showAnswersAfterSubmission !== undefined) updates.show_answers_after_submission = body.showAnswersAfterSubmission;
  if (body.allowRetake !== undefined) updates.allow_retake = body.allowRetake;
  if (body.status !== undefined) updates.status = body.status;
  if (body.questionIds !== undefined) updates.question_ids = body.questionIds;

  const { error } = await db.from("tests").update(updates).eq("id", id);
  if (error) {
    console.error("[admin/tests/patch]", error);
    return NextResponse.json({ error: "Failed to update test" }, { status: 500 });
  }

  // Update assignment if provided
  if (body.teacherIds !== undefined || body.studentIds !== undefined || body.classGroupIds !== undefined) {
    const assignUpdates: Record<string, unknown> = {};
    if (body.teacherIds !== undefined) assignUpdates.teacher_ids = body.teacherIds;
    if (body.studentIds !== undefined) assignUpdates.student_ids = body.studentIds;
    if (body.classGroupIds !== undefined) assignUpdates.class_group_ids = body.classGroupIds;

    await db.from("test_assignments").update(assignUpdates).eq("test_id", id);
  }

  return NextResponse.json({ success: true });
}
