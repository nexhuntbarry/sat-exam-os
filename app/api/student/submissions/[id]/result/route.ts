import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

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
        test_name, show_answers_after_submission,
        modules!inner(module_name, section)
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

  const test = submission.tests as unknown as { show_answers_after_submission: boolean };
  let answerDetails = null;

  if (test.show_answers_after_submission) {
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

    answerDetails = records ?? [];
  }

  return NextResponse.json({
    data: {
      ...submission,
      answerDetails,
    },
  });
}
