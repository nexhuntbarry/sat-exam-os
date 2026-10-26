import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import {
  TEST_STATUSES,
  dateOrderError,
  moduleApprovalError,
  moduleSetError,
  parseTimestamp,
  roleError,
  testNameError,
  thresholdError,
  timeLimitError,
} from "../../_shared";

// GET /api/admin/tests/[id]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;
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
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const linkCheck = await forbidCrossSide(authResult, {
    userIds: [
      ...(Array.isArray(body.teacherIds) ? (body.teacherIds as string[]) : []),
      ...(Array.isArray(body.studentIds) ? (body.studentIds as string[]) : []),
    ],
    classGroupIds: Array.isArray(body.classGroupIds) ? (body.classGroupIds as string[]) : [],
  });
  if (linkCheck) return linkCheck;

  const db = getServiceClient();
  const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

  const { data: current } = await db
    .from("tests")
    .select("is_adaptive, status, open_date, due_date, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id")
    .eq("id", id)
    .maybeSingle();
  if (!current) return bad("Test not found", 404);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // Same field rules as POST /api/admin/tests.
  if (body.testName !== undefined) {
    const err = testNameError(body.testName);
    if (err) return bad(err);
    updates.test_name = String(body.testName).trim();
  }
  if (body.timeLimitMinutes !== undefined) {
    const err = timeLimitError(body.timeLimitMinutes, "Time limit");
    if (err) return bad(err);
    updates.time_limit_minutes = body.timeLimitMinutes;
  }
  if (body.timeLimitMinutesModule2 !== undefined) {
    const err = timeLimitError(body.timeLimitMinutesModule2, "Module 2 time limit");
    if (err) return bad(err);
    updates.time_limit_minutes_module_2 = body.timeLimitMinutesModule2;
  }
  if (body.openDate !== undefined) {
    const { value, error } = parseTimestamp(body.openDate, "Open date");
    if (error) return bad(error);
    updates.open_date = value;
  }
  if (body.dueDate !== undefined) {
    const { value, error } = parseTimestamp(body.dueDate, "Due date");
    if (error) return bad(error);
    updates.due_date = value;
  }
  if (body.openDate !== undefined || body.dueDate !== undefined) {
    const err = dateOrderError(
      (body.openDate !== undefined ? updates.open_date : current.open_date) as string | null,
      (body.dueDate !== undefined ? updates.due_date : current.due_date) as string | null,
    );
    if (err) return bad(err);
  }
  if (body.showAnswersAfterSubmission !== undefined) updates.show_answers_after_submission = body.showAnswersAfterSubmission;
  if (body.allowRetake !== undefined) updates.allow_retake = body.allowRetake;
  if (body.status !== undefined) {
    if (!TEST_STATUSES.includes(body.status as (typeof TEST_STATUSES)[number])) {
      return bad(`Status must be one of ${TEST_STATUSES.join(", ")}`);
    }
    updates.status = body.status;
  }
  if (body.questionIds !== undefined) updates.question_ids = body.questionIds;
  if (body.desmosEnabled !== undefined) updates.desmos_enabled = Boolean(body.desmosEnabled);
  if (body.formulaSheetUrl !== undefined) updates.formula_sheet_url = body.formulaSheetUrl;
  if (body.adaptiveThreshold !== undefined) {
    const err = thresholdError(body.adaptiveThreshold);
    if (err) return bad(err);
    updates.adaptive_threshold = body.adaptiveThreshold;
  }

  // Module swaps. is_adaptive is intentionally NOT mutable here — once
  // a test is created adaptive vs non-adaptive, switching mid-stream
  // would orphan existing submissions whose adaptive_track/session_id
  // were keyed on the original mode. Admins who need a different mode
  // create a new test.
  const moduleFields = {
    moduleId: "module_id",
    module2Id: "module_2_id",
    module1Id: "module_1_id",
    module2EasyId: "module_2_easy_id",
    module2HardId: "module_2_hard_id",
  } as const;
  const next: Record<string, string | null> = {
    module_id: current.module_id,
    module_2_id: current.module_2_id,
    module_1_id: current.module_1_id,
    module_2_easy_id: current.module_2_easy_id,
    module_2_hard_id: current.module_2_hard_id,
  };
  let modulesChanged = false;
  for (const [key, col] of Object.entries(moduleFields)) {
    const v = body[key];
    if (v === undefined) continue;
    const value = v ? String(v) : null;
    if (value === next[col]) continue;
    next[col] = value;
    updates[col] = value;
    modulesChanged = true;
  }

  if (modulesChanged) {
    // Existing submissions (and their grades) point at the old module's
    // questions; swapping would make review, scores and new attempts
    // disagree. Force a new test instead.
    const { count } = await db
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("test_id", id);
    if ((count ?? 0) > 0) {
      return bad(
        "This test already has submissions, so its modules can't be changed. Create a new test with the modules you want instead.",
        409,
      );
    }

    if (current.is_adaptive) {
      if (!next.module_1_id) return bad("Adaptive test requires Module 1");
      if (!next.module_2_easy_id && !next.module_2_hard_id) {
        return bad("Adaptive test requires at least one Module 2 track (easy or hard)");
      }
      if (next.module_1_id === next.module_2_easy_id || next.module_1_id === next.module_2_hard_id) {
        return bad("Module 2 tracks must differ from Module 1");
      }
    } else {
      if (!next.module_id) return bad("A module is required");
      if (next.module_2_id && next.module_2_id === next.module_id) {
        return bad("Module 1 and Module 2 must be different");
      }
      // Single-module tests are valid (migration 0025), but clearing an
      // existing Module 2 is almost always an accident that leaves the
      // exam showing one module. Only block that transition.
      if (current.module_2_id && !next.module_2_id) {
        return bad(
          "This test already has a Module 2. Pick a replacement instead of clearing it, or create a single-module test.",
        );
      }
    }

    const ids = (current.is_adaptive
      ? [next.module_1_id, next.module_2_easy_id, next.module_2_hard_id]
      : [next.module_id, next.module_2_id]
    ).filter((x): x is string => Boolean(x));
    const err = (await moduleSetError(db, ids)) ?? (await moduleApprovalError(db, ids));
    if (err) return bad(err);
  }

  if (updates.status === "Published" && current.status !== "Published") {
    const ids = [
      next.module_id, next.module_2_id, next.module_1_id, next.module_2_easy_id, next.module_2_hard_id,
    ].filter((x): x is string => Boolean(x));
    const err = await moduleApprovalError(db, ids);
    if (err) return bad(err, 409);
  }

  const roleErr =
    (await roleError(db, Array.isArray(body.teacherIds) ? (body.teacherIds as string[]) : undefined, "teacher")) ??
    (await roleError(db, Array.isArray(body.studentIds) ? (body.studentIds as string[]) : undefined, "student"));
  if (roleErr) return bad(roleErr);

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
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;
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
    return NextResponse.json({ error: "Failed to delete test" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    deleted: { id, test_name: target.test_name },
  });
}
