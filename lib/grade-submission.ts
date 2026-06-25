// lib/grade-submission.ts
//
// Shared grading helper so both the interactive submit route
// (`POST /api/student/submissions/[id]/submit`) and the background
// cron auto-finalizer use identical scoring + answer-record logic.
// Any change in scoring should live here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { scaleSectionScore } from "@/lib/scoring";

function normalizeAnswer(answer: string | null | undefined): string {
  if (answer == null) return "";
  const s = answer.trim().toLowerCase();
  const fractionMatch = s.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (fractionMatch) {
    const num = parseFloat(fractionMatch[1]);
    const den = parseFloat(fractionMatch[2]);
    if (den !== 0) return String(Math.round((num / den) * 10000) / 10000);
  }
  return s;
}

function answersMatch(
  student: string | null | undefined,
  correct: string | null | undefined,
): boolean {
  if (!correct) return false;
  const sNorm = normalizeAnswer(student);
  const cNorm = normalizeAnswer(correct);
  if (sNorm === cNorm) return true;
  const sNum = parseFloat(sNorm);
  const cNum = parseFloat(cNorm);
  if (!isNaN(sNum) && !isNaN(cNum)) {
    return Math.abs(sNum - cNum) < 0.0001;
  }
  return false;
}

export interface FinalizeSubmissionInput {
  submissionId: string;
  /** Pre-loaded submission row. */
  submission: {
    id: string;
    test_id: string;
    answers: Record<string, string> | null;
    started_at: string;
    module_id: string | null;
    adaptive_track: string | null;
  };
  /** Pre-loaded test row. */
  test: {
    id: string;
    module_id: string;
    question_ids: string[] | null;
    is_adaptive: boolean | null;
    due_date: string | null;
  };
  /** Override status when the caller knows the deadline rule
   *  (cron sets "Late" when past due_date; submit infers it). */
  forcedStatus?: "Submitted" | "Late";
  db: SupabaseClient;
}

export interface FinalizeSubmissionResult {
  status: "Submitted" | "Late";
  correctCount: number;
  totalQuestions: number;
  percentage: number;
  scaledScore: number | null;
  scaledSection: string | null;
  timeSpentSeconds: number;
}

/**
 * Grade + flip the submission to a final state. Inserts the full
 * answer_records batch then updates the submission row. Returns
 * the computed score so the caller can log / report it.
 */
export async function finalizeSubmission(
  input: FinalizeSubmissionInput,
): Promise<FinalizeSubmissionResult> {
  const { submissionId, submission, test, db } = input;
  const gradingModuleId = submission.module_id ?? test.module_id;
  if (!gradingModuleId) {
    throw new Error("Submission has no grading module");
  }

  const { data: gradingModule } = await db
    .from("modules")
    .select("section")
    .eq("id", gradingModuleId)
    .maybeSingle();
  const moduleSection = (gradingModule?.section as string | null) ?? null;

  const now = new Date();
  const startedAt = new Date(submission.started_at);
  const timeSpentSeconds = Math.max(
    0,
    Math.floor((now.getTime() - startedAt.getTime()) / 1000),
  );

  const isPastDue = test.due_date && new Date(test.due_date) < now;
  const finalStatus =
    input.forcedStatus ?? (isPastDue ? "Late" : "Submitted");

  let questionQuery = db
    .from("questions")
    .select("id, correct_answer, question_type, original_question_number")
    .eq("module_id", gradingModuleId)
    .neq("parsing_status", "Rejected")
    .order("original_question_number", { ascending: true });

  if (
    !test.is_adaptive &&
    Array.isArray(test.question_ids) &&
    test.question_ids.length > 0
  ) {
    questionQuery = questionQuery.in("id", test.question_ids);
  }
  const { data: questions, error: qErr } = await questionQuery;
  if (qErr || !questions) {
    throw new Error(`fetch questions: ${qErr?.message ?? "unknown"}`);
  }

  const answers = (submission.answers ?? {}) as Record<string, string>;
  const totalQuestions = questions.length;

  const answerRecords = questions.map((q) => {
    const studentAnswer = answers[q.id] ?? null;
    const isCorrect = answersMatch(studentAnswer, q.correct_answer);
    return {
      submission_id: submissionId,
      question_id: q.id,
      student_answer: studentAnswer,
      correct_answer: q.correct_answer ?? null,
      is_correct: isCorrect,
      time_spent_seconds:
        totalQuestions > 0 ? Math.floor(timeSpentSeconds / totalQuestions) : 0,
    };
  });

  const correctCount = answerRecords.filter((r) => r.is_correct).length;
  const percentage =
    totalQuestions > 0
      ? Math.round((correctCount / totalQuestions) * 100 * 10) / 10
      : 0;
  const scaledScore = totalQuestions > 0 ? scaleSectionScore(percentage) : null;

  if (answerRecords.length > 0) {
    const { error: arErr } = await db.from("answer_records").insert(answerRecords);
    if (arErr) throw new Error(`insert answer_records: ${arErr.message}`);
  }

  const { error: upErr } = await db
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
    .eq("id", submissionId);
  if (upErr) throw new Error(`update submission: ${upErr.message}`);

  return {
    status: finalStatus,
    correctCount,
    totalQuestions,
    percentage,
    scaledScore,
    scaledSection: moduleSection,
    timeSpentSeconds,
  };
}
