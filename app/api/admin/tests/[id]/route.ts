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
      is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, adaptive_threshold,
      desmos_enabled, formula_sheet_url,
      modules!module_id(module_name, section, module_number, source_name)
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
  if (body.timeLimitMinutesModule2 !== undefined)
    updates.time_limit_minutes_module_2 = body.timeLimitMinutesModule2;
  if (body.openDate !== undefined) updates.open_date = body.openDate;
  if (body.dueDate !== undefined) updates.due_date = body.dueDate;
  if (body.showAnswersAfterSubmission !== undefined) updates.show_answers_after_submission = body.showAnswersAfterSubmission;
  if (body.allowRetake !== undefined) updates.allow_retake = body.allowRetake;
  if (body.status !== undefined) updates.status = body.status;
  if (body.questionIds !== undefined) updates.question_ids = body.questionIds;
  if (body.desmosEnabled !== undefined) updates.desmos_enabled = Boolean(body.desmosEnabled);
  if (body.formulaSheetUrl !== undefined) updates.formula_sheet_url = body.formulaSheetUrl;
  // Module swaps. is_adaptive is intentionally NOT mutable here — once
  // a test is created adaptive vs non-adaptive, switching mid-stream
  // would orphan existing submissions whose adaptive_track/session_id
  // were keyed on the original mode. Admins who need a different mode
  // create a new test.
  if (body.moduleId !== undefined) updates.module_id = body.moduleId;
  if (body.module2Id !== undefined) updates.module_2_id = body.module2Id;
  if (body.module1Id !== undefined) updates.module_1_id = body.module1Id;
  if (body.module2EasyId !== undefined) updates.module_2_easy_id = body.module2EasyId;
  if (body.module2HardId !== undefined) updates.module_2_hard_id = body.module2HardId;
  if (body.adaptiveThreshold !== undefined)
    updates.adaptive_threshold = body.adaptiveThreshold;

  // Defense against the "exam only shows one module" regression. A
  // non-adaptive test that ends up with module_2_id = null leaves the
  // /submissions/[id]/submit handoff with nothing to dispatch to and
  // the student sees Module 1 alone. The DB CHECK constraint added
  // in migration 0024 makes the same write fail loud, but we also
  // intercept here so the error surfaces as a 400 with a clear
  // message instead of a generic 500.
  if (body.module2Id !== undefined && body.module2Id === null) {
    const { data: current } = await db
      .from("tests")
      .select("is_adaptive")
      .eq("id", id)
      .maybeSingle();
    if (current && current.is_adaptive !== true) {
      return NextResponse.json(
        {
          error:
            "Non-adaptive tests must keep Module 2 set. Pick a Module 2 from the dropdown or switch the test to adaptive first.",
        },
        { status: 400 },
      );
    }
  }

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

// DELETE /api/admin/tests/[id]
//
// Permanently removes a test plus everything that hangs off it
// (assignments, submissions, answer_records, retake grants). All those
// child tables already declare ON DELETE CASCADE on their test_id FK, so
// the row delete is enough.
//
// We intentionally allow deletion of Published tests too — the admin UI
// double-confirms, and there are legitimate "I created this in error,
// scrap it" cases. If we wanted a softer guarantee later, swap to a
// soft-delete flag on tests.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data: target } = await db
    .from("tests")
    .select("id, test_name")
    .eq("id", id)
    .maybeSingle();
  if (!target) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }

  const { error } = await db.from("tests").delete().eq("id", id);
  if (error) {
    console.error("[admin/tests/DELETE]", error);
    return NextResponse.json(
      { error: `Failed to delete test: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    deleted: { id, test_name: target.test_name },
  });
}
