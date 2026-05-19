import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { scaleSectionScore } from "@/lib/scoring";

// POST /api/admin/submissions/[id]/force-submit
//
// Admin variant of /api/student/submissions/[id]/submit. Used when a
// student is locked out, can't trigger submit themselves, but the
// answers they HAVE entered need to be graded and the submission
// closed out. Reads the latest answers from the submission row and
// runs the same grading pipeline.
//
// Does NOT trigger the Module-1 → Module-2 handoff. If admin force-
// submits Module 1 of a two-module test, the student stays parked and
// admin can create the Module 2 submission manually (or by using
// reset on the next attempt).
function normalize(answer: string | null | undefined): string {
  if (answer == null) return "";
  const s = answer.trim().toLowerCase();
  const fraction = s.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (fraction) {
    const num = parseFloat(fraction[1]);
    const den = parseFloat(fraction[2]);
    if (den !== 0) return String(Math.round((num / den) * 10000) / 10000);
  }
  return s;
}
function answersMatch(a: string | null | undefined, b: string | null | undefined) {
  if (!b) return false;
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  const x = parseFloat(na);
  const y = parseFloat(nb);
  if (!isNaN(x) && !isNaN(y)) return Math.abs(x - y) < 0.0001;
  return false;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const db = getServiceClient();

  const { data: submission } = await db
    .from("submissions")
    .select(
      "id, test_id, answers, started_at, status, module_id, adaptive_track",
    )
    .eq("id", id)
    .maybeSingle();
  if (!submission) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }
  if (submission.status !== "In Progress") {
    return NextResponse.json(
      { error: `Submission already ${submission.status}` },
      { status: 400 },
    );
  }

  const { data: test } = await db
    .from("tests")
    .select("module_id, due_date, question_ids, is_adaptive")
    .eq("id", submission.test_id)
    .maybeSingle();
  if (!test) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }

  const gradingModuleId = submission.module_id ?? test.module_id;
  if (!gradingModuleId) {
    return NextResponse.json(
      { error: "Submission has no module to grade against" },
      { status: 500 },
    );
  }

  const { data: gradingModule } = await db
    .from("modules")
    .select("section")
    .eq("id", gradingModuleId)
    .maybeSingle();
  const moduleSection = gradingModule?.section ?? null;

  let qq = db
    .from("questions")
    .select("id, correct_answer, question_type, original_question_number")
    .eq("module_id", gradingModuleId)
    .neq("parsing_status", "Rejected")
    .order("original_question_number", { ascending: true });
  if (
    !test.is_adaptive &&
    Array.isArray(test.question_ids) &&
    (test.question_ids as string[]).length > 0
  ) {
    qq = qq.in("id", test.question_ids as string[]);
  }
  const { data: questions, error: qErr } = await qq;
  if (qErr || !questions) {
    return NextResponse.json(
      { error: "Failed to fetch questions" },
      { status: 500 },
    );
  }

  const answers = (submission.answers ?? {}) as Record<string, string>;
  const totalQuestions = questions.length;
  const now = new Date();
  const startedAt = new Date(submission.started_at);
  const timeSpentSeconds = Math.floor(
    (now.getTime() - startedAt.getTime()) / 1000,
  );

  const records = questions.map((q) => {
    const studentAnswer = answers[q.id] ?? null;
    const isCorrect = answersMatch(studentAnswer, q.correct_answer);
    return {
      submission_id: id,
      question_id: q.id,
      student_answer: studentAnswer,
      correct_answer: q.correct_answer ?? null,
      is_correct: isCorrect,
      time_spent_seconds: Math.floor(timeSpentSeconds / Math.max(1, totalQuestions)),
    };
  });

  // Wipe any stale answer_records (defense in depth if this is a re-
  // run after a partial submit attempt) then re-insert fresh.
  await db.from("answer_records").delete().eq("submission_id", id);
  if (records.length > 0) {
    const { error: arErr } = await db.from("answer_records").insert(records);
    if (arErr) {
      console.error("[admin/submissions/force-submit/answer_records]", arErr);
      return NextResponse.json(
        { error: "Failed to record answers" },
        { status: 500 },
      );
    }
  }

  const correctCount = records.filter((r) => r.is_correct).length;
  const percentage = totalQuestions > 0
    ? Math.round((correctCount / totalQuestions) * 100 * 10) / 10
    : 0;
  const scaledScore = totalQuestions > 0 ? scaleSectionScore(percentage) : null;
  const isPastDue = test.due_date && new Date(test.due_date) < now;
  const finalStatus = isPastDue ? "Late" : "Submitted";

  const { error: updErr } = await db
    .from("submissions")
    .update({
      status: finalStatus,
      submitted_at: now.toISOString(),
      score: correctCount,
      correct_count: correctCount,
      total_questions: totalQuestions,
      percentage,
      scaled_score: scaledScore,
      scaled_section: moduleSection,
      time_spent_seconds: timeSpentSeconds,
    })
    .eq("id", id);
  if (updErr) {
    console.error("[admin/submissions/force-submit/update]", updErr);
    return NextResponse.json(
      { error: "Failed to finalize submission" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    status: finalStatus,
    correctCount,
    totalQuestions,
    percentage,
  });
}
