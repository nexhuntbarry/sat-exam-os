import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { extractFinalAnswer, inferImpliedAnswer } from "@/lib/ai/solve-question";
import { rescoreQuestion } from "@/lib/rescore";
import { approveBlockedMessage, findApproveBlocker } from "@/lib/parse-guards";
import { clearReviewTags } from "@/lib/key-doubt";
import { dropStaleKeyNotes } from "@/lib/review-queue";
import { isLiveQuestion, KEY_ROW_SELECT, keyExplanationWarning, prepareKeyChange } from "@/lib/key-change";
import type { AutoFixRow } from "@/lib/explanation-autofix";
import { moduleKeyFacts, officialKeyProblem } from "@/lib/key-source";

// Writes + checks the explanation for the settled key (AI) — allow headroom.
export const maxDuration = 300;

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
    .select(`${KEY_ROW_SELECT}, mismatch_with_official`)
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

  const blocker = findApproveBlocker(q.question_text, q.choices, q.question_type);
  if (blocker) {
    return NextResponse.json({ error: approveBlockedMessage(blocker) }, { status: 400 });
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
    update.parsing_notes = clearReviewTags(cleaned);
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
    // trust === "official": only a key that really came from the PDF's
    // answer page / ✓ marks (lib/key-source). A value the AI made up while
    // reading a PDF without a key must not be restored by one click.
    if (!q.official_answer) {
      return NextResponse.json({ error: "This question has no official key from the PDF. Choose the AI's answer or edit the key." }, { status: 400 });
    }
    const { data: modRows } = q.module_id
      ? await db.from("questions").select("original_question_number, question_type, official_answer, parsing_notes").eq("module_id", q.module_id)
      : { data: null };
    const problem = officialKeyProblem(q, modRows ? moduleKeyFacts(modRows) : null);
    if (problem) {
      return NextResponse.json({ error: `The stored "official" key isn't from the PDF: ${problem}. Choose the AI's answer or edit the key.` }, { status: 400 });
    }
    finalAnswer = (q.official_answer as string | null) ?? (q.correct_answer as string | null);
  }

  // The settled key must fit the question type (a letter on a fill-in
  // question, a fill-in value that ignores the rounding asked for…).
  const keyBlocker = findApproveBlocker(q.question_text, q.choices, q.question_type, finalAnswer);
  if (keyBlocker) {
    return NextResponse.json({ error: approveBlockedMessage(keyBlocker) }, { status: 400 });
  }

  update.correct_answer = finalAnswer;

  // A new key makes the notes about the old one stale (consensus, semantic
  // audit, "stored X", key doubts): drop them.
  if (finalAnswer !== (q.correct_answer as string | null)) {
    const base = "parsing_notes" in update ? (update.parsing_notes as string | null) : (q.parsing_notes as string | null);
    update.parsing_notes = dropStaleKeyNotes(base, q.correct_answer as string | null, finalAnswer).notes;
  }

  // The settled key is saved together with an explanation written from an
  // independent solve and checked (lib/key-change.ts). The current one is
  // kept only when the key didn't change and it passes every check. If no
  // checked explanation can be had, the key is still saved but the question
  // is NOT approved (a live one stays Approved, explanation hidden).
  const keyChanged = finalAnswer !== (q.correct_answer as string | null);
  const live = await isLiveQuestion(db, id, q.parsing_status as string | null);
  const prepared = await prepareKeyChange(
    db,
    {
      ...(q as AutoFixRow),
      correct_answer: finalAnswer,
      official_answer: "official_answer" in update ? (update.official_answer as string | null) : (q.official_answer as string | null),
      parsing_notes: "parsing_notes" in update ? (update.parsing_notes as string | null) : (q.parsing_notes as string | null),
    },
    { live, keepCurrent: !keyChanged, keyChanged, userId: reviewer.userId, route: "key-change" },
  );
  Object.assign(update, prepared.patch);
  if (!prepared.ok) {
    delete update.reviewed_by;
    delete update.reviewed_at;
    if (live) delete update.parsing_status;
  }

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

  // Settling the key can flip already-submitted answers — re-grade them so
  // past score reports reflect the resolved answer.
  let rescore;
  if (keyChanged) {
    try {
      rescore = await rescoreQuestion(db, id);
    } catch (e) {
      console.error("[resolve-mismatch] rescore failed:", e);
    }
  }

  return NextResponse.json({
    data: updated,
    rescore,
    approved: prepared.ok && updated.parsing_status === "Approved",
    explanation: prepared.explanation.outcome,
    warning: keyExplanationWarning(live, prepared.explanation) ?? undefined,
  });
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
