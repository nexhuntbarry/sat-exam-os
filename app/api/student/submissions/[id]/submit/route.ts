import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { scaleSectionScore } from "@/lib/scoring";

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
// Optional JSON body: { answers?: Record<questionId,string>; metadata?: object }
// When the client supplies the latest answers in the request body, we use
// them directly and skip the separate autosave PATCH the UI used to fire
// first. Cuts submit latency roughly in half by collapsing two round
// trips into one.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;
  const db = getServiceClient();

  // Inline-save body (optional): collapses what used to be a PATCH +
  // POST roundtrip into one POST. If parsing fails or fields are
  // missing we simply skip the save — grading still falls back to the
  // last DB-persisted answers.
  let inlineAnswers: Record<string, string> | null = null;
  let inlineMetadata: Record<string, unknown> | null = null;
  try {
    const body = (await req.clone().json()) as
      | { answers?: Record<string, string>; metadata?: Record<string, unknown> }
      | undefined;
    if (body?.answers && typeof body.answers === "object") {
      inlineAnswers = body.answers;
    }
    if (body?.metadata && typeof body.metadata === "object") {
      inlineMetadata = body.metadata;
    }
  } catch {
    /* No body / non-JSON → fall back to DB-stored answers. */
  }

  // Fetch submission
  const { data: submission, error: subError } = await db
    .from("submissions")
    .select(
      "id, test_id, student_id, answers, status, started_at, attempt_number, session_id, module_id, adaptive_track",
    )
    .eq("id", id)
    .eq("student_id", user.userId)
    .single();

  if (subError || !submission) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }

  if (submission.status !== "In Progress") {
    return NextResponse.json({ error: "Submission already submitted" }, { status: 400 });
  }

  // Fetch test. We pull adaptive routing fields too — they're only used
  // when this submission is the Module 1 of an adaptive attempt, but
  // pulling them here keeps the query count down.
  const { data: test, error: testError } = await db
    .from("tests")
    .select(
      "id, module_id, module_2_id, time_limit_minutes, due_date, question_ids, is_adaptive, module_2_easy_id, module_2_hard_id, adaptive_threshold",
    )
    .eq("id", submission.test_id)
    .single();

  if (testError || !test) {
    return NextResponse.json({ error: "Test not found" }, { status: 500 });
  }

  // Grade against the submission's own module — for legacy/non-adaptive
  // submissions this matches tests.module_id; for adaptive it picks the
  // correct slot (module_1 / module_2_easy / module_2_hard).
  const gradingModuleId = submission.module_id ?? test.module_id;
  if (!gradingModuleId) {
    return NextResponse.json({ error: "Submission has no module" }, { status: 500 });
  }

  const { data: gradingModule } = await db
    .from("modules")
    .select("section")
    .eq("id", gradingModuleId)
    .maybeSingle();
  const moduleSection = gradingModule?.section ?? null;

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
    .eq("module_id", gradingModuleId)
    .neq("parsing_status", "Rejected")
    .order("original_question_number", { ascending: true });

  // tests.question_ids is a per-test subset only meaningful on the
  // single-module path. Adaptive tests grade every question of the
  // selected module, so skip the filter when adaptive.
  if (
    !test.is_adaptive &&
    test.question_ids &&
    Array.isArray(test.question_ids) &&
    test.question_ids.length > 0
  ) {
    questionQuery = questionQuery.in("id", test.question_ids);
  }

  const { data: questions, error: qError } = await questionQuery;
  if (qError || !questions) {
    return NextResponse.json({ error: "Failed to fetch questions" }, { status: 500 });
  }

  // Prefer the answers the client just sent (latest). Fall back to
  // whatever's in the DB if the client didn't supply any.
  const answers = (inlineAnswers ??
    (submission.answers as Record<string, string> | null) ??
    {}) as Record<string, string>;
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
  const scaledScore = totalQuestions > 0 ? scaleSectionScore(percentage) : null;

  // Insert answer records (batch)
  const { error: arError } = await db.from("answer_records").insert(answerRecords);
  if (arError) {
    console.error("[submit/answer_records]", arError);
    return NextResponse.json({ error: "Failed to save answer records" }, { status: 500 });
  }

  // Update submission. Fold inline answers + metadata in here so we
  // don't need the separate PATCH the UI used to send before submit.
  const submissionUpdates: Record<string, unknown> = {
    status: finalStatus,
    submitted_at: now.toISOString(),
    score: correctCount,
    correct_count: correctCount,
    total_questions: totalQuestions,
    percentage,
    scaled_score: scaledScore,
    scaled_section: moduleSection,
    time_spent_seconds: timeSpentSeconds,
  };
  if (inlineAnswers) submissionUpdates.answers = inlineAnswers;
  if (inlineMetadata) submissionUpdates.metadata = inlineMetadata;
  const { error: updateError } = await db
    .from("submissions")
    .update(submissionUpdates)
    .eq("id", id);

  if (updateError) {
    console.error("[submit/update_submission]", updateError);
    return NextResponse.json({ error: "Failed to finalize submission" }, { status: 500 });
  }

  // Module 1 → Module 2 handoff. Two paths share the same handoff
  // shape (insert a fresh In-Progress submission in the same session),
  // they only differ in how the next module is chosen.
  let nextSubmissionId: string | null = null;
  if (submission.adaptive_track === "module_1" && submission.session_id) {
    let nextModuleId: string | null = null;
    let nextTrack: "module_2" | "module_2_easy" | "module_2_hard" | null = null;

    if (test.is_adaptive) {
      const threshold = test.adaptive_threshold ?? 60;
      const wantHard = percentage >= threshold;
      // Pick the chosen track first, fall back to the other when the
      // chosen one wasn't configured. The start endpoint already
      // refused to launch a test missing both tracks.
      nextModuleId = wantHard
        ? test.module_2_hard_id ?? null
        : test.module_2_easy_id ?? null;
      nextTrack = wantHard ? "module_2_hard" : "module_2_easy";
      if (!nextModuleId) {
        nextModuleId = wantHard
          ? test.module_2_easy_id ?? null
          : test.module_2_hard_id ?? null;
        nextTrack = wantHard ? "module_2_easy" : "module_2_hard";
      }
    } else if (test.module_2_id) {
      // Non-adaptive 2-module test: fixed handoff, no routing decision.
      nextModuleId = test.module_2_id;
      nextTrack = "module_2";
    }

    if (nextModuleId && nextTrack) {
      const { data: nextSub, error: nextErr } = await db
        .from("submissions")
        .insert({
          test_id: submission.test_id,
          student_id: submission.student_id,
          answers: {},
          status: "In Progress",
          started_at: new Date().toISOString(),
          attempt_number: submission.attempt_number,
          metadata: {},
          session_id: submission.session_id,
          module_id: nextModuleId,
          adaptive_track: nextTrack,
        })
        .select("id")
        .single();

      if (nextErr || !nextSub) {
        console.error("[submit/module2_handoff]", nextErr);
        // Module 1 is already graded; refusing now would strand the
        // attempt. Return success without a next-id so the UI lands on
        // Module 1 result and an admin can intervene.
      } else {
        nextSubmissionId = nextSub.id;
      }
    }
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
      nextSubmissionId,
    },
  });
}
