import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/teacher/tests/[id]/analytics/[question_id]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; question_id: string }> }
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId, question_id: questionId } = await params;
  const db = getServiceClient();

  // Verify access
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

  // Fetch question
  const { data: question } = await db
    .from("questions")
    .select("id, original_question_number, question_text, choices, correct_answer, explanation, difficulty, domain, skill")
    .eq("id", questionId)
    .single();

  if (!question) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  // Submitted submission IDs for this test
  const { data: submissionRows } = await db
    .from("submissions")
    .select("id, student_id")
    .eq("test_id", testId)
    .in("status", ["Submitted", "Late"]);

  const subIds = (submissionRows ?? []).map((s) => s.id);
  const studentIdMap: Record<string, string> = {};
  for (const s of submissionRows ?? []) {
    studentIdMap[s.id] = s.student_id;
  }

  // Answer records for this question
  const { data: answerRecords } = await db
    .from("answer_records")
    .select("submission_id, student_answer, is_correct, time_spent_seconds")
    .in("submission_id", subIds)
    .eq("question_id", questionId);

  const records = answerRecords ?? [];
  const totalSubmissions = subIds.length;

  // Choice distribution
  const choiceDist: Record<string, number> = {};
  let correctCount = 0;
  let blankCount = 0;
  for (const ar of records) {
    const choice = ar.student_answer ?? "blank";
    choiceDist[choice] = (choiceDist[choice] ?? 0) + 1;
    if (ar.is_correct) correctCount++;
    if (!ar.student_answer) blankCount++;
  }

  // Students who got it wrong / right — fetch names
  const wrongSubmissionIds = records.filter((r) => r.is_correct === false).map((r) => r.submission_id);
  const rightSubmissionIds = records.filter((r) => r.is_correct === true).map((r) => r.submission_id);

  const wrongStudentIds = [...new Set(wrongSubmissionIds.map((sid) => studentIdMap[sid]).filter(Boolean))];
  const rightStudentIds = [...new Set(rightSubmissionIds.map((sid) => studentIdMap[sid]).filter(Boolean))];

  const { data: wrongStudents } = wrongStudentIds.length > 0
    ? await db.from("users").select("id, display_name, email").in("id", wrongStudentIds)
    : { data: [] };

  const { data: rightStudents } = rightStudentIds.length > 0
    ? await db.from("users").select("id, display_name, email").in("id", rightStudentIds)
    : { data: [] };

  // Map submission IDs for wrong students (for linking to submission detail)
  const wrongStudentSubmissions = wrongSubmissionIds.map((sid) => ({
    submissionId: sid,
    studentId: studentIdMap[sid],
  }));

  // Teacher note for this question
  const { data: noteRows } = await db
    .from("test_teacher_notes")
    .select("note_type, note_body")
    .eq("test_id", testId)
    .eq("teacher_id", user.userId)
    .eq("question_id", questionId);

  const classReview = noteRows?.find((n) => n.note_type === "class_review")?.note_body === "true";
  const privateNote = noteRows?.find((n) => n.note_type === "private_note")?.note_body ?? "";

  const avgTime = records.length > 0
    ? records.reduce((sum, r) => sum + (r.time_spent_seconds ?? 0), 0) / records.length
    : null;

  return NextResponse.json({
    question: {
      id: question.id,
      questionNumber: question.original_question_number,
      questionText: question.question_text,
      choices: question.choices,
      correctAnswer: question.correct_answer,
      explanation: question.explanation,
      difficulty: question.difficulty,
      domain: question.domain,
      skill: question.skill,
    },
    stats: {
      totalSubmissions,
      correctCount,
      wrongCount: records.length - correctCount,
      blankCount,
      avgTimeSeconds: avgTime,
      choiceDistribution: choiceDist,
    },
    wrongStudents: wrongStudents ?? [],
    rightStudents: rightStudents ?? [],
    wrongStudentSubmissions,
    classReview,
    privateNote,
  });
}
