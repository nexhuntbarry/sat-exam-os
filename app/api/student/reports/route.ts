import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { isTestAssignedToStudent } from "@/lib/student-exam";
import {
  STUDENT_REPORT_KINDS,
  STUDENT_REPORT_NOTE_MAX,
  STUDENT_REPORT_TYPE,
  studentReportsEnabledFor,
  type StudentReport,
  type StudentReportContext,
  type StudentReportKind,
} from "@/lib/student-reports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTEXTS: StudentReportContext[] = ["taking", "results", "review"];
const MAX_PER_SUBMISSION = 20;
const PER_QUESTION_COOLDOWN_MS = 60_000;

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

// POST /api/student/reports — a student flags a problem with one question.
// Body: { testId, questionId, submissionId?, kind, note?, context, displayNumber? }
// Write-only: it never touches the submission, answers, timer or score, and
// the response carries nothing but an ok/error (no question or answer data).
export async function POST(req: Request) {
  const auth = await requireRole("student");
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("Invalid request");
  }
  const testId = String(body.testId ?? "");
  const questionId = String(body.questionId ?? "");
  const submissionId = body.submissionId == null || body.submissionId === "" ? null : String(body.submissionId);
  const kind = String(body.kind ?? "") as StudentReportKind;
  const context = String(body.context ?? "") as StudentReportContext;
  const note = typeof body.note === "string" ? body.note.trim() : "";
  const displayNumber =
    typeof body.displayNumber === "number" && Number.isInteger(body.displayNumber) && body.displayNumber > 0 && body.displayNumber < 1000
      ? body.displayNumber
      : null;

  if (!UUID.test(testId) || !UUID.test(questionId) || (submissionId && !UUID.test(submissionId))) {
    return bad("Invalid request");
  }
  if (!STUDENT_REPORT_KINDS.includes(kind)) return bad("Pick a problem type");
  if (!CONTEXTS.includes(context)) return bad("Invalid request");
  if (note.length > STUDENT_REPORT_NOTE_MAX) return bad(`Note is too long (${STUDENT_REPORT_NOTE_MAX} characters max)`);

  const db = getServiceClient();
  if (!(await studentReportsEnabledFor(db, auth))) {
    return bad("Reporting is turned off right now", 403);
  }

  // Access: the student's own submission for this test, or (no submission,
  // e.g. the class review page) an assignment to the test.
  let submissionModuleId: string | null = null;
  if (submissionId) {
    const { data: sub } = await db
      .from("submissions")
      .select("id, test_id, student_id, module_id")
      .eq("id", submissionId)
      .maybeSingle();
    if (!sub || sub.student_id !== auth.userId || sub.test_id !== testId) return bad("Not found", 404);
    submissionModuleId = (sub.module_id as string | null) ?? null;
  } else if (!(await isTestAssignedToStudent(db, testId, auth.userId))) {
    return bad("Not found", 404);
  }

  const [{ data: test }, { data: question }] = await Promise.all([
    db
      .from("tests")
      .select("id, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id")
      .eq("id", testId)
      .maybeSingle(),
    db
      .from("questions")
      .select("id, module_id, original_question_number")
      .eq("id", questionId)
      .maybeSingle(),
  ]);
  if (!test || !question) return bad("Not found", 404);
  const testModules = new Set(
    [test.module_id, test.module_2_id, test.module_1_id, test.module_2_easy_id, test.module_2_hard_id].filter(
      (x): x is string => Boolean(x),
    ),
  );
  if (!testModules.has(question.module_id as string)) return bad("Not found", 404);
  // A submission covers one module; the question must be from it.
  if (submissionModuleId && submissionModuleId !== question.module_id) {
    return bad("Not found", 404);
  }

  // Rate limits: MAX_PER_SUBMISSION per submission (per test when there is
  // none), and one report per question per minute (double clicks, retries).
  const { data: recent, error: recentErr } = await db
    .from("notifications")
    .select("created_at, payload->>question_id")
    .eq("user_id", auth.userId)
    .eq("type", STUDENT_REPORT_TYPE)
    .eq("payload->>test_id", testId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (recentErr) return bad("Couldn't send right now", 500);
  const rows = (recent ?? []) as unknown as { created_at: string; question_id: string | null }[];
  let used = rows.length;
  if (submissionId) {
    const { count } = await db
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", auth.userId)
      .eq("type", STUDENT_REPORT_TYPE)
      .eq("payload->>submission_id", submissionId);
    used = count ?? 0;
  }
  if (used >= MAX_PER_SUBMISSION) {
    return bad("You've sent the maximum number of reports for this test", 429);
  }
  const justReported = rows.some(
    (r) => r.question_id === questionId && Date.now() - new Date(r.created_at).getTime() < PER_QUESTION_COOLDOWN_MS,
  );
  if (justReported) {
    return bad("You just reported this question. Please wait a minute before sending another.", 429);
  }

  const now = new Date().toISOString();
  const payload: StudentReport = {
    kind,
    status: "new",
    test_id: testId,
    submission_id: submissionId,
    module_id: question.module_id as string,
    question_id: questionId,
    question_number: (question.original_question_number as number | null) ?? null,
    display_number: displayNumber,
    context,
    note,
    qa: auth.isQa,
  };
  const { error } = await db
    .from("notifications")
    // read_at is set so the row never counts as an unread bell item.
    .insert({ user_id: auth.userId, type: STUDENT_REPORT_TYPE, payload, read_at: now });
  if (error) {
    console.error("[student/reports POST]", error.message);
    return bad("Couldn't send right now", 500);
  }
  return NextResponse.json({ ok: true });
}
