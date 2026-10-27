import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { extractFinalAnswer, inferImpliedAnswer, explainOneAnswer } from "@/lib/ai/solve-question";
import { rescoreQuestion } from "@/lib/rescore";
import { findParsePlaceholder } from "@/lib/parse-guards";

export const maxDuration = 60;

// POST /api/admin/questions/[id]/resolve-mismatch
//
// Body: { trust: "ai" | "official" }
//
// One-click resolver for the cross-check mismatch flow. After parse +
// solver runs, every question that disagreed with the answer key is
// flagged with mismatch_with_official=true and parsing_status="Needs
// Review". The admin reviews both answers + AI explanation, then picks
// which one to trust:
//   - "ai":       correct_answer ← the value parsed out of the
//                 "AI: X, official: Y" hint embedded in parsing_notes;
//                 mismatch_with_official cleared; status → Approved.
//   - "official": correct_answer is already official (parse-time
//                 reconciliation overwrote it); we just clear the
//                 mismatch flag and approve.
//
// Returns the updated question row so the client can refresh in place.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const qaBlock = forbidQa(authResult);
  if (qaBlock) return qaBlock;
  const reviewer = authResult;

  const { id } = await params;
  let body: { trust?: "ai" | "official" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.trust !== "ai" && body.trust !== "official") {
    return NextResponse.json(
      { error: "trust must be 'ai' or 'official'" },
      { status: 400 },
    );
  }

  const db = getServiceClient();
  const { data: q, error: fetchErr } = await db
    .from("questions")
    .select(
      "id, correct_answer, official_answer, parsing_notes, mismatch_with_official, explanation, question_type, question_text, choices",
    )
    .eq("id", id)
    .single();

  if (fetchErr || !q) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  if (!q.mismatch_with_official) {
    return NextResponse.json(
      { error: "This question is not flagged as mismatched" },
      { status: 409 },
    );
  }

  const placeholder = findParsePlaceholder(q.question_text, q.choices);
  if (placeholder) {
    return NextResponse.json(
      { error: `Can't approve: the stem or choices contain parser placeholder text ("${placeholder}"). Fix the text first.` },
      { status: 400 },
    );
  }

  const update: Record<string, unknown> = {
    mismatch_with_official: false,
    parsing_status: "Approved",
    reviewed_by: reviewer.userId,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Strip the trailing "; Mismatch: AI answered X, official Y" segment
  // from parsing_notes so the resolved hint doesn't clutter future
  // displays. Other notes (Low confidence, etc.) are preserved.
  if (typeof q.parsing_notes === "string") {
    const cleaned = q.parsing_notes
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s && !/^Mismatch:/i.test(s))
      .join("; ");
    update.parsing_notes = cleaned || null;
  }

  // Determine the answer we're settling on.
  let finalAnswer: string | null;
  if (body.trust === "ai") {
    // Recover the AI's answer robustly: prefer the "Mismatch: AI answered X"
    // note, but fall back to the answer the explanation actually argues for /
    // the stored correct_answer — so re-processed rows (whose note was
    // overwritten) can still be resolved.
    const isMcq = q.question_type === "Multiple Choice";
    const expl = (q.explanation as string | null) ?? "";
    finalAnswer =
      parseAiAnswerFromNotes(q.parsing_notes as string | null) ??
      extractFinalAnswer(expl) ??
      inferImpliedAnswer(expl, isMcq) ??
      (q.correct_answer as string | null);
    if (!finalAnswer) {
      return NextResponse.json(
        { error: "Could not determine the AI's answer for this question" },
        { status: 422 },
      );
    }
    // Overruling the key: drop official_answer so the student UI never shows it.
    update.official_answer = null;
  } else {
    // trust === "official"
    finalAnswer = (q.official_answer as string | null) ?? (q.correct_answer as string | null);
  }

  update.correct_answer = finalAnswer;

  const { data: updated, error: updateErr } = await db
    .from("questions")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (updateErr || !updated) {
    console.error("[resolve-mismatch] update error:", updateErr);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  // Regenerate the explanation to justify the chosen answer, so the stored
  // answer and its explanation can never contradict each other (the reported
  // bug: pick the key = A but the old explanation still argued D). Best effort:
  // if it fails, the answer is still correct, just with the prior explanation.
  let newExplanation = updated.explanation as string | null;
  if (finalAnswer) {
    const regenerated = await explainOneAnswer(id, finalAnswer, db, reviewer.userId);
    if (regenerated) newExplanation = regenerated;
  }

  // Settling the key can flip already-submitted answers — re-grade them so
  // past score reports reflect the resolved answer.
  let rescore;
  if (finalAnswer !== (q.correct_answer as string | null)) {
    try {
      rescore = await rescoreQuestion(db, id);
    } catch (e) {
      console.error("[resolve-mismatch] rescore failed:", e);
    }
  }

  return NextResponse.json({ data: { ...updated, correct_answer: finalAnswer, explanation: newExplanation }, rescore });
}

/**
 * Pull the AI's answer out of a "Mismatch: AI answered X, official Y"
 * snippet inside parsing_notes. Tolerant of multiple notes joined by
 * "; ". Returns null when no AI answer is recoverable.
 */
function parseAiAnswerFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  const m = notes.match(/Mismatch:\s*AI answered\s+([^,;]+?)\s*,\s*official/i);
  return m ? m[1].trim() : null;
}
