import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getAnswerVisibility } from "@/lib/answer-visibility";
import { orderToQuestionIds, type QuestionSetScope } from "@/lib/student-exam";

// GET /api/student/submissions/[id]/result
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
      id, test_id, student_id, status, score, correct_count, total_questions,
      percentage, started_at, submitted_at, time_spent_seconds, attempt_number,
      tests!inner(
        test_name, module_id, module_2_id, is_adaptive, question_ids,
        modules!module_id(module_name, section)
      )
    `)
    .eq("id", id)
    .eq("student_id", user.userId)
    .single();

  if (error || !submission) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }

  if (submission.status === "In Progress") {
    return NextResponse.json({ error: "Submission not yet submitted" }, { status: 400 });
  }

  // Answer/explanation reveal goes through the shared decision (test
  // setting, class lock, per-student override, retake safety).
  const visibility = await getAnswerVisibility(db, submission.test_id, user.userId, "results");
  let answerDetails = null;

  if (visibility.answers) {
    const { data: records } = await db
      .from("answer_records")
      .select(`
        id, question_id, student_answer, correct_answer, is_correct,
        questions!inner(
          original_question_number, question_text, choices, question_type,
          explanation, difficulty, domain, skill
        )
      `)
      .eq("submission_id", id)
      .order("questions(original_question_number)", { ascending: true });

    const test = submission.tests as unknown as QuestionSetScope;
    // A quiz picked from several source tests: the teacher's pick order.
    const ordered = orderToQuestionIds(records ?? [], test, test.module_id ? [test.module_id] : [], (r) => r.question_id as string);
    answerDetails = ordered.map((r) => {
      if (visibility.explanations) return r;
      const q = r.questions as unknown as Record<string, unknown>;
      return { ...r, questions: { ...q, explanation: null } };
    });
  }

  return NextResponse.json({
    data: {
      ...submission,
      answerDetails,
      showExplanations: visibility.explanations,
    },
  });
}
