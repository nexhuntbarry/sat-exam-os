import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { explainOneAnswer } from "@/lib/ai/solve-question";
import { rescoreQuestion } from "@/lib/rescore";
import { approveBlockedMessage, findApproveBlocker } from "@/lib/parse-guards";
import { MAX_KEY_LENGTH, keyTypeProblem } from "@/lib/answer-key";
import { liveQuestionIds } from "@/lib/live-questions";
import { clearReviewTags, hasReviewTags } from "@/lib/key-doubt";

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

  for (const k of ["correct_answer", "official_answer"] as const) {
    if (typeof update[k] === "string" && (update[k] as string).length > MAX_KEY_LENGTH) {
      return NextResponse.json(
        { error: `The ${k === "correct_answer" ? "answer key" : "official answer"} can be at most ${MAX_KEY_LENGTH} characters.` },
        { status: 400 },
      );
    }
  }

  const db = getServiceClient();

  // Capture the prior answer so we can tell whether the key actually changed.
  const { data: prior } = await db
    .from("questions")
    .select("correct_answer, question_text, choices, question_type, parsing_status, parsing_notes")
    .eq("id", id)
    .maybeSingle();

  // Never let an edit flip a question to Approved while it still carries
  // parser placeholder text or looks cut off (checked against the post-edit
  // stem/choices).
  const next = {
    question_text: "question_text" in update ? (update.question_text as string | null) : prior?.question_text,
    choices: "choices" in update ? update.choices : prior?.choices,
    question_type: "question_type" in update ? (update.question_type as string | null) : prior?.question_type,
    correct_answer: "correct_answer" in update ? (update.correct_answer as string | null) : prior?.correct_answer,
  };
  if (update.parsing_status === "Approved") {
    const blocker = findApproveBlocker(next.question_text, next.choices, next.question_type, next.correct_answer ?? null);
    if (blocker) {
      return NextResponse.json({ error: approveBlockedMessage(blocker) }, { status: 400 });
    }
  }

  // An Approved question stays Approved through a save, so a key or type
  // edit that leaves the two mismatched (a letter key on a fill-in
  // question…) is refused the same way an approve would be.
  const keyOrTypeChanged =
    (prior?.correct_answer ?? null) !== (next.correct_answer ?? null) ||
    (prior?.question_type ?? null) !== (next.question_type ?? null);
  const resultIsApproved = ("parsing_status" in update ? update.parsing_status : prior?.parsing_status) === "Approved";
  if (resultIsApproved && keyOrTypeChanged && update.parsing_status !== "Approved") {
    const p = keyTypeProblem(next);
    if (p) {
      // Never advise demoting a question students are taking right now.
      const live = (await liveQuestionIds(db, [id]).catch(() => new Set<string>([id]))).has(id);
      const advice = live
        ? "Fix it before saving — this question is in a live test, so keep it Approved."
        : "Fix it, or mark it Needs Review first.";
      return NextResponse.json(
        { error: `Can't save this Approved question: ${p.reason}. ${advice}` },
        { status: 400 },
      );
    }
  }

  // Saving it as Approved means a person checked it: clear the live-test
  // re-check tag.
  const resultStatus = "parsing_status" in update ? update.parsing_status : prior?.parsing_status;
  const resultNotes = "parsing_notes" in update ? (update.parsing_notes as string | null) : prior?.parsing_notes;
  if (resultStatus === "Approved" && hasReviewTags(resultNotes)) {
    update.parsing_notes = clearReviewTags(resultNotes);
  }

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
