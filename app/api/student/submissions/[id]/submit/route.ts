import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

/** Normalize answer for comparison */
function normalizeAnswer(answer: string | null | undefined): string {
  if (answer == null) return "";
  const s = answer.trim().toLowerCase();
  // Try to convert fractions to decimal for SPR numeric comparison
  const fractionMatch = s.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (fractionMatch) {
    const num = parseFloat(fractionMatch[1]);
    const den = parseFloat(fractionMatch[2]);
    if (den !== 0) return String(Math.round((num / den) * 10000) / 10000);
  }
  return s;
}

function answersMatch(student: string | null | undefined, correct: string | null | undefined): boolean {
  if (!correct) return false;
  const sNorm = normalizeAnswer(student);
  const cNorm = normalizeAnswer(correct);
  if (sNorm === cNorm) return true;
  // Numeric comparison for SPR
  const sNum = parseFloat(sNorm);
  const cNum = parseFloat(cNorm);
  if (!isNaN(sNum) && !isNaN(cNum)) {
    return Math.abs(sNum - cNum) < 0.0001;
  }
  return false;
}

// POST /api/student/submissions/[id]/submit
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;
  const db = getServiceClient();

  // Fetch submission
  const { data: submission, error: subError } = await db
    .from("submissions")
    .select("id, test_id, student_id, answers, status, started_at, attempt_number")
    .eq("id", id)
    .eq("student_id", user.userId)
    .single();

  if (subError || !submission) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }

  if (submission.status !== "In Progress") {
    return NextResponse.json({ error: "Submission already submitted" }, { status: 400 });
  }

  // Fetch test
  const { data: test, error: testError } = await db
    .from("tests")
    .select("id, module_id, time_limit_minutes, due_date, question_ids")
    .eq("id", submission.test_id)
    .single();

  if (testError || !test) {
    return NextResponse.json({ error: "Test not found" }, { status: 500 });
  }

  const now = new Date();
  const startedAt = new Date(submission.started_at);
  const timeSpentSeconds = Math.floor((now.getTime() - startedAt.getTime()) / 1000);

  // Determine status
  const isPastDue = test.due_date && new Date(test.due_date) < now;
  const finalStatus = isPastDue ? "Late" : "Submitted";

  // Fetch questions for grading
  let questionQuery = db
    .from("questions")
    .select("id, correct_answer, question_type, original_question_number")
    .eq("module_id", test.module_id)
    .neq("parsing_status", "Rejected")
    .order("original_question_number", { ascending: true });

  if (test.question_ids && Array.isArray(test.question_ids) && test.question_ids.length > 0) {
    questionQuery = questionQuery.in("id", test.question_ids);
  }

  const { data: questions, error: qError } = await questionQuery;
  if (qError || !questions) {
    return NextResponse.json({ error: "Failed to fetch questions" }, { status: 500 });
  }

  const answers = (submission.answers ?? {}) as Record<string, string>;
  const totalQuestions = questions.length;

  // Grade each question
  const answerRecords = questions.map((q) => {
    const studentAnswer = answers[q.id] ?? null;
    const isCorrect = answersMatch(studentAnswer, q.correct_answer);
    return {
      submission_id: id,
      question_id: q.id,
      student_answer: studentAnswer,
      correct_answer: q.correct_answer ?? null,
      is_correct: isCorrect,
      time_spent_seconds: Math.floor(timeSpentSeconds / totalQuestions),
    };
  });

  const correctCount = answerRecords.filter((r) => r.is_correct).length;
  const percentage = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100 * 10) / 10 : 0;

  // Insert answer records (batch)
  const { error: arError } = await db.from("answer_records").insert(answerRecords);
  if (arError) {
    console.error("[submit/answer_records]", arError);
    return NextResponse.json({ error: "Failed to save answer records" }, { status: 500 });
  }

  // Update submission
  const { error: updateError } = await db
    .from("submissions")
    .update({
      status: finalStatus,
      submitted_at: now.toISOString(),
      score: correctCount,
      correct_count: correctCount,
      total_questions: totalQuestions,
      percentage,
      time_spent_seconds: timeSpentSeconds,
    })
    .eq("id", id);

  if (updateError) {
    console.error("[submit/update_submission]", updateError);
    return NextResponse.json({ error: "Failed to finalize submission" }, { status: 500 });
  }

  return NextResponse.json({
    data: {
      id,
      status: finalStatus,
      score: correctCount,
      correctCount,
      totalQuestions,
      percentage,
      timeSpentSeconds,
    },
  });
}
