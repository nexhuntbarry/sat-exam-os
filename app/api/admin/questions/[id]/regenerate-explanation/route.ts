import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { regenerateExplanation } from "@/lib/ai/solve-question";

// Up to two Claude calls (one retry when the first explanation looks cut off).
export const maxDuration = 120;

// POST /api/admin/questions/[id]/regenerate-explanation
// Body: { question_text, choices, correct_answer, question_type } — the
// review page's CURRENT values, including unsaved edits.
//
// Read-only: returns a preview explanation plus the answer the AI gets on
// its own. Nothing is written; the reviewer clicks Use (fills the field)
// and then Save.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const answer = typeof body.correct_answer === "string" ? body.correct_answer.trim() : "";
  const questionText = typeof body.question_text === "string" ? body.question_text : "";
  if (!answer) {
    return NextResponse.json({ ok: false, error: "Set the correct answer first." }, { status: 400 });
  }
  if (!questionText.trim()) {
    return NextResponse.json({ ok: false, error: "The question text is empty." }, { status: 400 });
  }

  // Only the stored figures come from the DB (image edits save immediately);
  // text, choices and answer come from the page.
  const db = getServiceClient();
  const { data: q } = await db
    .from("questions")
    .select("id, original_question_number, image_urls")
    .eq("id", id)
    .maybeSingle();
  if (!q) return NextResponse.json({ ok: false, error: "Question not found" }, { status: 404 });

  const res = await regenerateExplanation(
    {
      questionId: id,
      questionNumber: q.original_question_number as number | null,
      questionText,
      choices: Array.isArray(body.choices) ? body.choices : [],
      questionType: typeof body.question_type === "string" ? body.question_type : null,
      answer,
      imageUrls: Array.isArray(q.image_urls) ? (q.image_urls as string[]) : null,
    },
    authResult.userId,
  );
  if (!res.ok) return NextResponse.json(res, { status: 422 });
  return NextResponse.json({ ok: true, explanation: res.explanation, ai_answer: res.aiAnswer, agrees: res.agrees });
}
