import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestAccess } from "@/lib/teacher-access";

// GET /api/teacher/tests/[id]/analytics
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId } = await params;
  const db = getServiceClient();

  // Two-track auth + class-scoped denominator for class teachers.
  const access = await getTeacherTestAccess(db, user, testId);
  if (access.mode === null) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch test questions (via question_ids or module)
  const { data: test } = await db
    .from("tests")
    .select(
      "id, test_name, module_id, module_2_id, question_ids, is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id",
    )
    .eq("id", testId)
    .single();

  if (!test) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get questions for this test. Adaptive tests pull from every
  // module slot since the analytics dashboard surfaces all questions
  // students might have seen across Module 1 + the chosen Module 2.
  let questionQuery = db
    .from("questions")
    .select("id, original_question_number, question_text, correct_answer, difficulty, domain, skill, explanation, question_type")
    .order("original_question_number", { ascending: true });

  const qIds = test.question_ids as string[] | null;
  if (!test.is_adaptive && qIds && qIds.length > 0) {
    questionQuery = questionQuery.in("id", qIds);
  } else if (test.is_adaptive) {
    const adaptiveModuleIds = [
      test.module_1_id,
      test.module_2_easy_id,
      test.module_2_hard_id,
    ].filter((x): x is string => Boolean(x));
    if (adaptiveModuleIds.length === 0) {
      return NextResponse.json({ questions: [], summary: null });
    }
    questionQuery = questionQuery.in("module_id", adaptiveModuleIds);
  } else if (test.module_2_id) {
    // Non-adaptive 2-module test → pull questions from both modules.
    questionQuery = questionQuery.in(
      "module_id",
      [test.module_id, test.module_2_id].filter((x): x is string => Boolean(x)),
    );
  } else {
    if (!test.module_id) {
      return NextResponse.json({ questions: [], summary: null });
    }
    questionQuery = questionQuery.eq("module_id", test.module_id);
  }

  const { data: questions } = await questionQuery;
  if (!questions || questions.length === 0) {
    return NextResponse.json({ questions: [], summary: null });
  }

  const questionIds = questions.map((q) => q.id);

  // Aggregate answer records across all submissions for this test
  // One query: get all answer records for these questions in this test's submissions
  let submissionIdsQuery = db
    .from("submissions")
    .select("id")
    .eq("test_id", testId)
    .in("status", ["Submitted", "Late"]);
  if (access.mode === "class" && access.studentAllowlist) {
    submissionIdsQuery = submissionIdsQuery.in(
      "student_id",
      Array.from(access.studentAllowlist),
    );
  }
  const { data: submissionIds } = await submissionIdsQuery;

  const subIds = (submissionIds ?? []).map((s) => s.id);
  const totalSubmissions = subIds.length;

  if (totalSubmissions === 0) {
    return NextResponse.json({
      questions: questions.map((q) => ({
        questionId: q.id,
        questionNumber: q.original_question_number,
        questionText: q.question_text,
        correctAnswer: q.correct_answer,
        difficulty: q.difficulty,
        domain: q.domain,
        skill: q.skill,
        explanation: q.explanation,
        totalSubmissions: 0,
        correctCount: 0,
        wrongCount: 0,
        blankCount: 0,
        flaggedCount: 0,
        avgTimeSeconds: null,
        choiceDistribution: {},
        mostSelectedWrong: null,
        classReview: false,
      })),
      summary: null,
    });
  }

  const { data: answerRecords } = await db
    .from("answer_records")
    .select("question_id, student_answer, correct_answer, is_correct, time_spent_seconds")
    .in("submission_id", subIds)
    .in("question_id", questionIds);

  // Fetch flagged question counts from submissions.answers jsonb
  const { data: submissionsWithAnswers } = await db
    .from("submissions")
    .select("id, answers")
    .in("id", subIds);

  // Count flagged per question
  const flaggedCount: Record<string, number> = {};
  for (const sub of submissionsWithAnswers ?? []) {
    const ans = sub.answers as Record<string, { flagged?: boolean }>;
    for (const [qid, val] of Object.entries(ans)) {
      if (val?.flagged) {
        flaggedCount[qid] = (flaggedCount[qid] ?? 0) + 1;
      }
    }
  }

  // Fetch teacher notes (class_review flags)
  const { data: notes } = await db
    .from("test_teacher_notes")
    .select("question_id, note_type, note_body")
    .eq("test_id", testId)
    .eq("teacher_id", user.userId)
    .eq("note_type", "class_review");

  const classReviewSet = new Set(
    (notes ?? [])
      .filter((n) => n.note_body === "true" && n.question_id)
      .map((n) => n.question_id as string)
  );

  // Aggregate per question
  const arMap: Record<string, {
    correctCount: number;
    wrongCount: number;
    blankCount: number;
    totalTime: number;
    timeCount: number;
    choiceDist: Record<string, number>;
  }> = {};

  for (const ar of answerRecords ?? []) {
    const qid = ar.question_id;
    if (!arMap[qid]) {
      arMap[qid] = { correctCount: 0, wrongCount: 0, blankCount: 0, totalTime: 0, timeCount: 0, choiceDist: {} };
    }
    const entry = arMap[qid];
    if (ar.is_correct) {
      entry.correctCount++;
    } else if (!ar.student_answer) {
      entry.blankCount++;
    } else {
      entry.wrongCount++;
    }
    if (ar.time_spent_seconds != null) {
      entry.totalTime += ar.time_spent_seconds;
      entry.timeCount++;
    }
    const choice = ar.student_answer ?? "blank";
    entry.choiceDist[choice] = (entry.choiceDist[choice] ?? 0) + 1;
  }

  // Build output
  const questionRows = questions.map((q) => {
    const agg = arMap[q.id];
    const choiceDist = agg?.choiceDist ?? {};
    const correctAns = q.correct_answer ?? "";

    // Most selected wrong answer
    let mostSelectedWrong: string | null = null;
    let maxWrongCount = 0;
    for (const [choice, cnt] of Object.entries(choiceDist)) {
      if (choice !== correctAns && choice !== "blank" && cnt > maxWrongCount) {
        maxWrongCount = cnt;
        mostSelectedWrong = choice;
      }
    }

    return {
      questionId: q.id,
      questionNumber: q.original_question_number,
      questionText: q.question_text,
      correctAnswer: correctAns,
      difficulty: q.difficulty,
      domain: q.domain,
      skill: q.skill,
      explanation: q.explanation,
      totalSubmissions,
      correctCount: agg?.correctCount ?? 0,
      wrongCount: agg?.wrongCount ?? 0,
      blankCount: agg?.blankCount ?? 0,
      flaggedCount: flaggedCount[q.id] ?? 0,
      avgTimeSeconds: agg?.timeCount ? agg.totalTime / agg.timeCount : null,
      choiceDistribution: choiceDist,
      mostSelectedWrong,
      classReview: classReviewSet.has(q.id),
    };
  });

  // Summary cards
  const sorted = [...questionRows].sort((a, b) => {
    const ar = a.totalSubmissions > 0 ? a.correctCount / a.totalSubmissions : 0;
    const br = b.totalSubmissions > 0 ? b.correctCount / b.totalSubmissions : 0;
    return ar - br;
  });

  const hardest = sorted[0] ?? null;
  const easiest = sorted[sorted.length - 1] ?? null;
  const mostFlagged = [...questionRows].sort((a, b) => b.flaggedCount - a.flaggedCount)[0] ?? null;
  const avgClassScore =
    totalSubmissions > 0
      ? questionRows.reduce((sum, q) => sum + (q.correctCount / (q.totalSubmissions || 1)), 0) /
        questionRows.length * 100
      : null;

  return NextResponse.json({
    questions: questionRows,
    summary: {
      hardestQuestion: hardest
        ? { questionNumber: hardest.questionNumber, correctRate: hardest.correctCount / (hardest.totalSubmissions || 1) * 100 }
        : null,
      easiestQuestion: easiest
        ? { questionNumber: easiest.questionNumber, correctRate: easiest.correctCount / (easiest.totalSubmissions || 1) * 100 }
        : null,
      mostFlaggedQuestion: mostFlagged
        ? { questionNumber: mostFlagged.questionNumber, flaggedCount: mostFlagged.flaggedCount }
        : null,
      avgClassScore,
      totalSubmissions,
    },
  });
}
