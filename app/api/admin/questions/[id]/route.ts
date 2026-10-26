import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { explainOneAnswer } from "@/lib/ai/solve-question";
import { rescoreQuestion } from "@/lib/rescore";

// Answer-key edits may regenerate the explanation (AI) — allow headroom.
export const maxDuration = 60;

// GET /api/admin/questions/[id]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data, error } = await db
    .from("questions")
    .select(`*, modules(module_name, source_name, pdf_url, section, difficulty, module_number)`)
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  return NextResponse.json({ data });
}

// PATCH /api/admin/questions/[id]
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const qaBlock = forbidQa(authResult);
  if (qaBlock) return qaBlock;

  const { id } = await params;
  const body = await req.json();

  // Whitelist updatable fields
  const allowed = [
    "question_text",
    "choices",
    "correct_answer",
    "explanation",
    "difficulty",
    "domain",
    "skill",
    "concept",
    "question_type",
    "has_image",
    "has_table",
    "has_formula",
    "parsing_status",
    "parsing_notes",
    "page_number",
    "official_answer",
    "mismatch_with_official",
  ] as const;

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }

  const db = getServiceClient();

  // Capture the prior answer so we can tell whether the key actually changed.
  const { data: prior } = await db
    .from("questions")
    .select("correct_answer")
    .eq("id", id)
    .maybeSingle();

  const { data, error } = await db
    .from("questions")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[questions/PATCH] error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  let result = data;

  // When the correct answer changed, keep everything downstream consistent:
  //  1. Regenerate the explanation so it argues the NEW key (unless the
  //     caller also supplied an explanation in this same edit — then they
  //     set both deliberately, so respect it).
  //  2. Re-grade already-submitted work so scores/score reports reflect the
  //     corrected key instead of the old one.
  const answerChanged =
    "correct_answer" in body &&
    (prior?.correct_answer ?? null) !== (body.correct_answer ?? null);

  if (answerChanged) {
    const newAnswer = body.correct_answer ? String(body.correct_answer) : "";
    if (newAnswer && !("explanation" in body)) {
      try {
        const regenerated = await explainOneAnswer(id, newAnswer, db, authResult.userId);
        if (regenerated) {
          const { data: refreshed } = await db
            .from("questions")
            .select()
            .eq("id", id)
            .single();
          if (refreshed) result = refreshed;
        }
      } catch (e) {
        console.error("[questions/PATCH] explanation regen failed:", e);
      }
    }
    try {
      const rescore = await rescoreQuestion(db, id);
      return NextResponse.json({ data: result, rescore });
    } catch (e) {
      console.error("[questions/PATCH] rescore failed:", e);
    }
  }

  return NextResponse.json({ data: result });
}
