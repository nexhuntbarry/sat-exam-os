import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/admin/tests
export async function GET(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "";
  const moduleId = searchParams.get("moduleId") ?? "";

  const db = getServiceClient();
  let query = db
    .from("tests")
    .select(`
      id, test_name, module_id, time_limit_minutes, open_date, due_date,
      show_answers_after_submission, allow_retake, status, question_ids,
      created_by, created_at, updated_at,
      modules!inner(module_name, section, module_number)
    `)
    .order("created_at", { ascending: false });

  if (status) query = query.eq("status", status);
  if (moduleId) query = query.eq("module_id", moduleId);

  const { data: tests, error } = await query;
  if (error) {
    console.error("[admin/tests/get]", error);
    return NextResponse.json({ error: "Failed to fetch tests" }, { status: 500 });
  }

  // Fetch assignments and submission counts
  const testIds = (tests ?? []).map((t) => t.id);
  let assignments: Record<string, { teacher_ids: string[]; student_ids: string[]; class_group_ids: string[] }> = {};
  let submissionCounts: Record<string, { done: number; total: number }> = {};

  if (testIds.length > 0) {
    const { data: assignData } = await db
      .from("test_assignments")
      .select("test_id, teacher_ids, student_ids, class_group_ids")
      .in("test_id", testIds);

    for (const a of assignData ?? []) {
      assignments[a.test_id] = {
        teacher_ids: a.teacher_ids ?? [],
        student_ids: a.student_ids ?? [],
        class_group_ids: a.class_group_ids ?? [],
      };
    }

    const { data: subData } = await db
      .from("submissions")
      .select("test_id, status")
      .in("test_id", testIds);

    for (const s of subData ?? []) {
      if (!submissionCounts[s.test_id]) submissionCounts[s.test_id] = { done: 0, total: 0 };
      submissionCounts[s.test_id].total++;
      if (s.status === "Submitted" || s.status === "Late") submissionCounts[s.test_id].done++;
    }
  }

  const enriched = (tests ?? []).map((t) => ({
    ...t,
    assignment: assignments[t.id] ?? { teacher_ids: [], student_ids: [], class_group_ids: [] },
    submissions: submissionCounts[t.id] ?? { done: 0, total: 0 },
  }));

  return NextResponse.json({ data: enriched });
}

// POST /api/admin/tests — create test
export async function POST(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const admin = authResult;

  let body: {
    testName: string;
    moduleId?: string;
    timeLimitMinutes?: number;
    openDate?: string;
    dueDate?: string;
    showAnswersAfterSubmission?: boolean;
    allowRetake?: boolean;
    questionIds?: string[];
    teacherIds?: string[];
    studentIds?: string[];
    classGroupIds?: string[];
    isAdaptive?: boolean;
    module1Id?: string;
    module2EasyId?: string;
    module2HardId?: string;
    adaptiveThreshold?: number;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.testName?.trim()) {
    return NextResponse.json({ error: "Test name is required" }, { status: 400 });
  }

  if (body.isAdaptive) {
    if (!body.module1Id) {
      return NextResponse.json(
        { error: "Adaptive test requires Module 1" },
        { status: 400 },
      );
    }
    if (!body.module2EasyId && !body.module2HardId) {
      return NextResponse.json(
        { error: "Adaptive test requires at least one Module 2 track (easy or hard)" },
        { status: 400 },
      );
    }
  } else if (!body.moduleId) {
    return NextResponse.json({ error: "Module is required" }, { status: 400 });
  }

  const db = getServiceClient();

  // Create test
  const { data: test, error: testError } = await db
    .from("tests")
    .insert({
      test_name: body.testName.trim(),
      // Single-module flag uses module_id; adaptive flag uses
      // module_1_id / module_2_*_id. The two paths are mutually
      // exclusive at create time, but stored separately so a future
      // admin tool can promote a single-module test to adaptive
      // without re-creating.
      module_id: body.isAdaptive ? null : body.moduleId ?? null,
      is_adaptive: Boolean(body.isAdaptive),
      module_1_id: body.isAdaptive ? body.module1Id ?? null : null,
      module_2_easy_id: body.isAdaptive ? body.module2EasyId ?? null : null,
      module_2_hard_id: body.isAdaptive ? body.module2HardId ?? null : null,
      adaptive_threshold:
        body.isAdaptive && typeof body.adaptiveThreshold === "number"
          ? Math.max(0, Math.min(100, Math.round(body.adaptiveThreshold)))
          : 60,
      time_limit_minutes: body.timeLimitMinutes ?? null,
      open_date: body.openDate ?? null,
      due_date: body.dueDate ?? null,
      show_answers_after_submission: body.showAnswersAfterSubmission ?? false,
      allow_retake: body.allowRetake ?? false,
      question_ids: body.questionIds ?? null,
      status: "Draft",
      created_by: admin.userId,
    })
    .select("id")
    .single();

  if (testError || !test) {
    console.error("[admin/tests/post]", testError);
    return NextResponse.json({ error: "Failed to create test" }, { status: 500 });
  }

  // Create assignment
  const { error: assignError } = await db.from("test_assignments").insert({
    test_id: test.id,
    teacher_ids: body.teacherIds ?? [],
    student_ids: body.studentIds ?? [],
    class_group_ids: body.classGroupIds ?? [],
    created_by: admin.userId,
  });

  if (assignError) {
    console.error("[admin/tests/post assignment]", assignError);
    // Don't fail — test is created, assignment can be fixed later
  }

  return NextResponse.json({ data: { id: test.id } }, { status: 201 });
}
