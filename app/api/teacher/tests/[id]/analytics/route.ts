import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, scopeIds } from "@/lib/qa";
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

  // Every submission row in scope (any status) — the Avg Class Score below
  // must match the Results page, which groups all rows into attempts first.
  let submissionIdsQuery = db
    .from("submissions")
    .select("id, session_id, adaptive_track, status, correct_count, total_questions, percentage")
    .eq("test_id", testId);
  if (access.mode === "class" && access.studentAllowlist) {
    submissionIdsQuery = submissionIdsQuery.in(
      "student_id",
      Array.from(access.studentAllowlist),
    );
  }
  submissionIdsQuery = scopeIds(submissionIdsQuery, "student_id", await getQaUserIds(), user.isQa);
  const { data: submissionRows } = await submissionIdsQuery;

  // Per-question stats use graded (Submitted/Late) module rows.
  const subIds = (submissionRows ?? [])
    .filter((s) => s.status === "Submitted" || s.status === "Late")
    .map((s) => s.id as string);

  // Attempts, exactly as the Results page builds them: group module rows by
  // session_id; an attempt with any In Progress module isn't submitted; its
  // score is combined correct/total (single-module: the row's percentage).
  const attemptRows = new Map<string, NonNullable<typeof submissionRows>>();
  for (const s of submissionRows ?? []) {
    const key = (s.session_id as string | null) ?? `solo:${s.id}`;
    attemptRows.set(key, [...(attemptRows.get(key) ?? []), s]);
  }
  const attemptPcts: number[] = [];
  for (const list of attemptRows.values()) {
    const rank = (t: unknown) => (t === "module_1" ? 0 : 1);
    const rows = [...list].sort((a, b) => rank(a.adaptive_track) - rank(b.adaptive_track));
    const statuses = rows.map((r) => r.status as string);
    if (statuses.includes("In Progress")) continue;
    const status = statuses.includes("Late") ? "Late" : statuses[statuses.length - 1];
    if (status !== "Submitted" && status !== "Late") continue;
    if (rows.length === 1) {
      attemptPcts.push(rows[0].percentage != null ? Number(rows[0].percentage) : 0);
      continue;
    }
    const correct = rows.reduce((n, r) => n + ((r.correct_count as number | null) ?? 0), 0);
    const total = rows.reduce((n, r) => n + ((r.total_questions as number | null) ?? 0), 0);
    attemptPcts.push(total > 0 ? Math.round((correct / total) * 1000) / 10 : 0);
  }
  const totalSubmissions = attemptPcts.length;

  if (subIds.length === 0) {
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
        wrongStudents: [],
      })),
      summary: null,
    });
  }

  type RawAnswerRecord = {
    question_id: string;
    student_answer: string | null;
    correct_answer: string | null;
    is_correct: boolean | null;
    time_spent_seconds: number | null;
    submissions: { student_id: string; users: { display_name: string } } | null;
  };

  const { data: rawAnswerRecords } = await db
    .from("answer_records")
    .select("question_id, student_answer, correct_answer, is_correct, time_spent_seconds, submissions!inner(student_id, users!inner(display_name))")
    .in("submission_id", subIds)
    .in("question_id", questionIds);

  const answerRecords = (rawAnswerRecords ?? []) as unknown as RawAnswerRecord[];

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
    .eq("note_type", "class_review")
    .is("student_id", null);

  const classReviewSet = new Set(
    (notes ?? [])
      .filter((n) => n.note_body === "true" && n.question_id)
      .map((n) => n.question_id as string)
  );

  // Aggregate per question
  const arMap: Record<string, {
    answered: number;
    correctCount: number;
    wrongCount: number;
    blankCount: number;
    totalTime: number;
    timeCount: number;
    choiceDist: Record<string, number>;
    wrongStudentNames: Set<string>;
  }> = {};

  for (const ar of answerRecords) {
    const qid = ar.question_id;
    if (!arMap[qid]) {
      arMap[qid] = { answered: 0, correctCount: 0, wrongCount: 0, blankCount: 0, totalTime: 0, timeCount: 0, choiceDist: {}, wrongStudentNames: new Set() };
    }
    const entry = arMap[qid];
    entry.answered++;
    const displayName = ar.submissions?.users?.display_name ?? null;
    if (ar.is_correct) {
      entry.correctCount++;
    } else if (!ar.student_answer) {
      entry.blankCount++;
    } else {
      entry.wrongCount++;
      if (displayName) entry.wrongStudentNames.add(displayName);
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
      // Students who were served this question (an adaptive Module 2
      // question is only seen on one track).
      totalSubmissions: agg?.answered ?? 0,
      correctCount: agg?.correctCount ?? 0,
      wrongCount: agg?.wrongCount ?? 0,
      blankCount: agg?.blankCount ?? 0,
      flaggedCount: flaggedCount[q.id] ?? 0,
      avgTimeSeconds: agg?.timeCount ? agg.totalTime / agg.timeCount : null,
      choiceDistribution: choiceDist,
      mostSelectedWrong,
      classReview: classReviewSet.has(q.id),
      wrongStudents: Array.from(agg?.wrongStudentNames ?? []).sort(),
    };
  });

  // Summary cards
  const answeredRows = questionRows.filter((q) => q.totalSubmissions > 0);
  const sorted = [...answeredRows].sort((a, b) => {
    const ar = a.totalSubmissions > 0 ? a.correctCount / a.totalSubmissions : 0;
    const br = b.totalSubmissions > 0 ? b.correctCount / b.totalSubmissions : 0;
    return ar - br;
  });

  const hardest = sorted[0] ?? null;
  const easiest = sorted[sorted.length - 1] ?? null;
  const mostFlagged = [...questionRows].sort((a, b) => b.flaggedCount - a.flaggedCount)[0] ?? null;
  // Avg Class Score = mean of each submitted attempt's combined %, the same
  // number the Results page shows.
  const avgClassScore =
    attemptPcts.length > 0
      ? attemptPcts.reduce((a, b) => a + b, 0) / attemptPcts.length
      : null;
  // A different metric: share of all answered questions that were correct
  // (weights attempts by how many questions they answered).
  const answeredTotal = answeredRows.reduce((n, q) => n + q.totalSubmissions, 0);
  const answeredCorrectPct =
    answeredTotal > 0
      ? (answeredRows.reduce((n, q) => n + q.correctCount, 0) / answeredTotal) * 100
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
      answeredCorrectPct,
      totalSubmissions,
    },
  });
}
