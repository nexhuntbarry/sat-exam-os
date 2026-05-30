import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/student/submissions/[id] — get submission state for resume
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data: submission, error } = await db
    .from("submissions")
    .select(`
      id, test_id, student_id, answers, status, started_at, submitted_at,
      time_spent_seconds, attempt_number, metadata, module_id, adaptive_track,
      tests!inner(
        id, test_name, module_id, time_limit_minutes, time_limit_minutes_module_2, due_date, show_answers_after_submission,
        is_adaptive,
        modules!module_id(module_name, section)
      )
    `)
    .eq("id", id)
    .eq("student_id", user.userId)
    .single();

  if (error || !submission) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }

  // Fetch questions for this submission's module. For adaptive tests
  // submission.module_id is the chosen Module 1 / Module 2 slot; for
  // legacy tests it falls back to tests.module_id.
  const test = submission.tests as unknown as {
    module_id: string | null;
    time_limit_minutes: number;
    time_limit_minutes_module_2?: number | null;
    question_ids?: string[] | null;
    is_adaptive?: boolean;
  };
  const gradingModuleId = submission.module_id ?? test.module_id;
  if (!gradingModuleId) {
    return NextResponse.json({ error: "Submission has no module" }, { status: 500 });
  }
  let questionQuery = db
    .from("questions")
    // SECURITY: correct_answer MUST NOT be returned during an active
    // exam. Students consume this endpoint to resume their test; any
    // field they fetch is visible in DevTools. The post-submit review
    // page reads correct_answer from submission_answers on its own
    // server-rendered path.
    .select("id, original_question_number, question_text, choices, question_type, has_image, has_table, source_pdf_url, section, domain, skill, difficulty")
    .eq("module_id", gradingModuleId)
    // Mirrors the take page gate — Approved-only. See the comment
    // in /student/tests/[id]/take/page.tsx.
    .eq("parsing_status", "Approved")
    .order("original_question_number", { ascending: true });

  // Filter to specific question_ids if the (legacy single-module) test has them
  const { data: testData } = await db
    .from("tests")
    .select("question_ids, is_adaptive")
    .eq("id", submission.test_id)
    .single();

  if (
    !testData?.is_adaptive &&
    testData?.question_ids &&
    Array.isArray(testData.question_ids) &&
    testData.question_ids.length > 0
  ) {
    questionQuery = questionQuery.in("id", testData.question_ids);
  }

  const { data: questions } = await questionQuery;

  // Calculate time remaining
  const startedAt = new Date(submission.started_at).getTime();
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - startedAt) / 1000);
  const isModule2 =
    submission.adaptive_track === "module_2" ||
    submission.adaptive_track === "module_2_easy" ||
    submission.adaptive_track === "module_2_hard";
  const activeTimeLimit = isModule2
    ? test.time_limit_minutes_module_2 ?? test.time_limit_minutes
    : test.time_limit_minutes;
  const timeLimitSeconds = (activeTimeLimit ?? 35) * 60;
  const timeRemainingSeconds = Math.max(0, timeLimitSeconds - elapsedSeconds);

  return NextResponse.json({
    data: {
      ...submission,
      questions: questions ?? [],
      timeRemainingSeconds,
    },
  });
}

// PATCH /api/student/submissions/[id] — auto-save answers
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;

  let body: { answers?: Record<string, string>; metadata?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const db = getServiceClient();

  // Verify ownership and status
  const { data: submission, error: fetchError } = await db
    .from("submissions")
    .select("id, student_id, status")
    .eq("id", id)
    .eq("student_id", user.userId)
    .single();

  if (fetchError || !submission) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }

  if (submission.status !== "In Progress") {
    return NextResponse.json({ error: "Submission is not in progress" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.answers !== undefined) updates.answers = body.answers;
  if (body.metadata !== undefined) updates.metadata = body.metadata;

  const { error } = await db.from("submissions").update(updates).eq("id", id);
  if (error) {
    console.error("[student/submissions/patch]", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
