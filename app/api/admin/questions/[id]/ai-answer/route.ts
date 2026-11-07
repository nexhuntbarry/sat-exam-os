import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { choicesWithStoredImages, independentAnswer } from "@/lib/ai/solve-question";

// One Claude call (plus figure fetches).
export const maxDuration = 60;

// POST /api/admin/questions/[id]/ai-answer
// Body: { question_text, choices, question_type } — the review page's
// CURRENT values, including unsaved edits. Figure and choice image URLs come
// from the saved row only.
//
// Read-only: the AI solves the question on its own (it never sees the saved
// key) and returns its answer. A fill-in answer is the AI's computation
// evaluated in code with the stem's rounding applied; disagreements come
// back as warnings. Nothing is written; the reviewer clicks Use, then Save.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const questionText = typeof body.question_text === "string" ? body.question_text : "";
  if (!questionText.trim()) {
    return NextResponse.json({ ok: false, error: "The question text is empty." }, { status: 400 });
  }

  const db = getServiceClient();
  const { data: q } = await db.from("questions").select("id, image_urls, choices").eq("id", id).maybeSingle();
  if (!q) return NextResponse.json({ ok: false, error: "Question not found" }, { status: 404 });

  const res = await independentAnswer(
    {
      questionId: id,
      questionText,
      choices: choicesWithStoredImages(body.choices, q.choices),
      questionType: typeof body.question_type === "string" ? body.question_type : null,
      imageUrls: Array.isArray(q.image_urls) ? (q.image_urls as string[]) : null,
    },
    authResult.userId,
  );
  if (!res.ok) return NextResponse.json(res, { status: 422 });
  return NextResponse.json(res);
}
