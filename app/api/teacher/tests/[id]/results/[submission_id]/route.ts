import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/teacher/tests/[id]/results/[submission_id]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; submission_id: string }> }
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId, submission_id: submissionId } = await params;
  const db = getServiceClient();

  // Verify teacher access
  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (
    user.role !== "admin" &&
    !(assignment.teacher_ids as string[]).includes(user.userId)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch submission
  const { data: submission } = await db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, started_at, submitted_at, time_spent_seconds, answers,
      tutor_notes, attempt_number,
      users!inner(display_name, email),
      student_profiles(grade, class_group)
    `)
    .eq("id", submissionId)
    .eq("test_id", testId)
    .single();

  if (!submission) return NextResponse.json({ error: "Submission not found" }, { status: 404 });

  // Fetch answer records with question details
  const { data: answerRecords } = await db
    .from("answer_records")
    .select(`
      id, question_id, student_answer, correct_answer, is_correct, time_spent_seconds,
      questions!inner(
        id, original_question_number, question_text, choices,
        correct_answer, explanation, difficulty, domain, skill, question_type
      )
    `)
    .eq("submission_id", submissionId)
    .order("questions(original_question_number)", { ascending: true });

  // Fetch flagged questions from submission answers jsonb
  const answersJson = submission.answers as Record<string, { flagged?: boolean }>;

  // Fetch teacher notes for this test+teacher
  const { data: notes } = await db
    .from("test_teacher_notes")
    .select("question_id, note_type, note_body")
    .eq("test_id", testId)
    .eq("teacher_id", user.userId);

  const notesMap: Record<string, { classReview: boolean; privateNote: string }> = {};
  for (const n of notes ?? []) {
    const qid = n.question_id ?? "";
    if (!notesMap[qid]) notesMap[qid] = { classReview: false, privateNote: "" };
    if (n.note_type === "class_review") notesMap[qid].classReview = n.note_body === "true";
    if (n.note_type === "private_note") notesMap[qid].privateNote = n.note_body;
  }

  const u = submission.users as unknown as { display_name: string; email: string };
  const sp = submission.student_profiles as unknown as { grade?: string; class_group?: string } | null;

  const answers = (answerRecords ?? []).map((ar) => {
    const q = ar.questions as unknown as {
      id: string;
      original_question_number: number;
      question_text: string;
      choices: Array<{ letter: string; text: string }>;
      correct_answer: string;
      explanation: string | null;
      difficulty: string | null;
      domain: string | null;
      skill: string | null;
      question_type: string;
    };
    const noteData = notesMap[q.id] ?? { classReview: false, privateNote: "" };
    const wasFlagged = answersJson[q.id]?.flagged === true;

    return {
      questionId: q.id,
      questionNumber: q.original_question_number,
      questionText: q.question_text,
      choices: q.choices ?? [],
      studentAnswer: ar.student_answer,
      correctAnswer: ar.correct_answer ?? q.correct_answer,
      isCorrect: ar.is_correct,
      timeSpentSeconds: ar.time_spent_seconds,
      wasFlagged,
      explanation: q.explanation,
      domain: q.domain,
      skill: q.skill,
      difficulty: q.difficulty,
      classReview: noteData.classReview,
      privateNote: noteData.privateNote,
    };
  });

  return NextResponse.json({
    student: {
      name: u.display_name,
      email: u.email,
      grade: sp?.grade ?? null,
      classGroup: sp?.class_group ?? null,
    },
    submission: {
      id: submission.id,
      status: submission.status,
      score: submission.score,
      percentage: submission.percentage,
      correctCount: submission.correct_count,
      totalQuestions: submission.total_questions,
      timeSpentSeconds: submission.time_spent_seconds,
      startedAt: submission.started_at,
      submittedAt: submission.submitted_at,
      tutorNotes: submission.tutor_notes ?? "",
      attemptNumber: submission.attempt_number ?? 1,
    },
    answers,
  });
}

// PATCH /api/teacher/tests/[id]/results/[submission_id]
// Accepts { tutorNotes } so a teacher can save 1-on-1 tutoring follow-up
// notes scoped to this attempt. Reuses the GET access check.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; submission_id: string }> },
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId, submission_id: submissionId } = await params;

  const db = getServiceClient();
  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (
    user.role !== "admin" &&
    !(assignment.teacher_ids as string[]).includes(user.userId)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { tutorNotes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.tutorNotes !== "string") {
    return NextResponse.json({ error: "tutorNotes is required" }, { status: 400 });
  }

  const { error } = await db
    .from("submissions")
    .update({
      tutor_notes: body.tutorNotes.slice(0, 8000), // hard cap to keep rows bounded
      updated_at: new Date().toISOString(),
    })
    .eq("id", submissionId)
    .eq("test_id", testId);

  if (error) {
    console.error("[teacher/results/PATCH]", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
