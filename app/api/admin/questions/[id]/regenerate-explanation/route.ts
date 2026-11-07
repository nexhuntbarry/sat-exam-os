import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { choicesWithStoredImages, regenerateExplanation } from "@/lib/ai/solve-question";

// AI calls: an independent solve, then the explanation (one retry when it
// looks cut off); figure questions add a high-resolution re-read of the
// figure and a second read that checks the values used.
export const maxDuration = 300;

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
  const qaBlock = forbidQa(authResult);
  if (qaBlock) return qaBlock;
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

  // Stored figures and choice images come from the DB (image edits save
  // immediately; body URLs are never fetched); text, choice text and answer
  // come from the page.
  const db = getServiceClient();
  const { data: q } = await db
    .from("questions")
    .select("id, original_question_number, image_urls, choices")
    .eq("id", id)
    .maybeSingle();
  if (!q) return NextResponse.json({ ok: false, error: "Question not found" }, { status: 404 });

  const res = await regenerateExplanation(
    {
      questionId: id,
      questionNumber: q.original_question_number as number | null,
      questionText,
      choices: choicesWithStoredImages(body.choices, q.choices),
      questionType: typeof body.question_type === "string" ? body.question_type : null,
      answer,
      imageUrls: Array.isArray(q.image_urls) ? (q.image_urls as string[]) : null,
    },
    authResult.userId,
  );
  if (!res.ok) return NextResponse.json(res, { status: 422 });
  // The AI solves first without the answer; when it reaches another one, no
  // explanation is written (it would only argue an answer it can't reproduce).
  if (!res.agrees && !res.explanation.trim()) {
    return NextResponse.json(
      {
        ok: false,
        ai_answer: res.aiAnswer,
        agrees: false,
        error: `Working it out on its own, the AI got ${res.aiAnswer ?? "a different answer"}, not ${answer}, so no explanation was written. Check the answer key.`,
      },
      { status: 422 },
    );
  }
  return NextResponse.json({ ok: true, explanation: res.explanation, ai_answer: res.aiAnswer, agrees: res.agrees });
}
