import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { rescoreQuestion } from "@/lib/rescore";
import { approveBlockedMessage, findApproveBlocker } from "@/lib/parse-guards";
import { MAX_KEY_LENGTH, keyTypeProblem } from "@/lib/answer-key";
import { liveQuestionIds } from "@/lib/live-questions";
import { clearReviewTags, hasReviewTags } from "@/lib/key-doubt";
import { dropStaleKeyNotes } from "@/lib/review-queue";
import { isLiveQuestion, KEY_ROW_SELECT, keyExplanationWarning, prepareKeyChange, type PreparedKeyChange } from "@/lib/key-change";
import type { AutoFixRow } from "@/lib/explanation-autofix";
import { editedExplanationProblem, staleSave } from "@/lib/question-save-guard";

// An answer-key edit writes + checks a new explanation (independent solve,
// then the explanation, one retry) — allow headroom.
export const maxDuration = 300;

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
  const { data: priorRow } = await db.from("questions").select(KEY_ROW_SELECT).eq("id", id).maybeSingle();
  const prior = priorRow as AutoFixRow | null;
  if (!prior) return NextResponse.json({ error: "Question not found" }, { status: 404 });

  // Optimistic concurrency. A page that loaded the question before a key
  // change (or a hidden live explanation) must not write its old key /
  // explanation back. `expected_updated_at` guards the whole row;
  // `base` guards just the key and explanation the page last saw (other
  // actions on the page — image edits, status buttons — change updated_at
  // without touching them, so the page sends `base`).
  const stale = NextResponse.json(
    { error: "This question's answer key or explanation changed since the page loaded (another save or a key change). Reload to see the current version — your edits were not saved." },
    { status: 409 },
  );
  if (staleSave(prior, body)) return stale;

  // Never let an edit flip a question to Approved while it still carries
  // parser placeholder text or looks cut off (checked against the post-edit
  // stem/choices).
  const next = {
    question_text: "question_text" in update ? (update.question_text as string | null) : prior?.question_text,
    choices: "choices" in update ? update.choices : prior?.choices,
    question_type: "question_type" in update ? (update.question_type as string | null) : prior?.question_type,
    correct_answer: "correct_answer" in update ? (update.correct_answer as string | null) : prior?.correct_answer,
    official_answer: "official_answer" in update ? (update.official_answer as string | null) : prior?.official_answer,
  };
  if (update.parsing_status === "Approved") {
    const blocker = findApproveBlocker(next.question_text, next.choices, next.question_type, next.correct_answer ?? null, next.official_answer ?? null);
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

  // A new key makes the notes about the old one stale (consensus, semantic
  // audit, "stored X", key doubts): drop them.
  if ("correct_answer" in body && (prior?.correct_answer ?? null) !== (body.correct_answer ?? null)) {
    const base = "parsing_notes" in update ? (update.parsing_notes as string | null) : (prior?.parsing_notes ?? null);
    const cleaned = dropStaleKeyNotes(base, prior?.correct_answer ?? null, body.correct_answer ?? null);
    if (cleaned.removed.length > 0) update.parsing_notes = cleaned.notes;
  }

  // A new key is saved only together with a checked explanation for it
  // (lib/key-change.ts). The reviewer's own edited explanation is kept when
  // it passes the checks for the new key; one that doesn't is refused.
  // Without an edit, the old explanation argued the old key: a new one is
  // written from an independent solve. If that fails the key is still
  // saved, but the question is not Approved (a live one stays Approved with
  // the explanation hidden and a [live-fix] note).
  const answerChanged =
    "correct_answer" in body &&
    (prior?.correct_answer ?? null) !== (body.correct_answer ?? null);
  let prepared: PreparedKeyChange | null = null;
  // A changed explanation (non-empty) must pass every check for the key it
  // will be saved with — with or without a key change in the same save.
  const explanationEdited = "explanation" in body && (body.explanation ?? "") !== (prior.explanation ?? "");
  const editedText = explanationEdited ? String(body.explanation ?? "").trim() : "";
  {
    const why = editedExplanationProblem(
      prior,
      { ...prior, question_text: next.question_text ?? null, choices: next.choices, question_type: next.question_type ?? null, correct_answer: next.correct_answer ?? null, official_answer: next.official_answer ?? null },
      body,
    );
    if (why) {
      return NextResponse.json(
        { error: `The explanation doesn't fit the answer key ${next.correct_answer}: ${why}. Fix it, or clear it${answerChanged ? " and save to have one written and checked" : ""}.` },
        { status: 400 },
      );
    }
  }
  if (answerChanged) {
    const nextRow: AutoFixRow = {
      ...prior,
      question_text: next.question_text ?? null,
      choices: next.choices,
      question_type: next.question_type ?? null,
      correct_answer: next.correct_answer ?? null,
      official_answer: next.official_answer ?? null,
      explanation: explanationEdited ? ((body.explanation as string | null) ?? null) : prior.explanation,
      parsing_status: ("parsing_status" in update ? (update.parsing_status as string | null) : prior.parsing_status) ?? null,
      parsing_notes: "parsing_notes" in update ? (update.parsing_notes as string | null) : prior.parsing_notes,
    };
    const live = await isLiveQuestion(db, id, prior.parsing_status);
    // Only the reviewer's own new text may be kept; the old text never is.
    prepared = await prepareKeyChange(db, nextRow, { live, keepCurrent: !!editedText, keyChanged: true, userId: authResult.userId, route: "key-change" });
    Object.assign(update, prepared.patch);
    // Never approve a key without a checked explanation in this same save.
    if (!prepared.ok && update.parsing_status === "Approved") {
      if (live) delete update.parsing_status;
      else update.parsing_status = "Needs Review";
    }
  }

  // Saving it as Approved means a person checked it: clear the live-test
  // re-check tag (not the one this save just added).
  const resultStatus = "parsing_status" in update ? update.parsing_status : prior?.parsing_status;
  const resultNotes = "parsing_notes" in update ? (update.parsing_notes as string | null) : prior?.parsing_notes;
  if (resultStatus === "Approved" && hasReviewTags(resultNotes) && (!prepared || prepared.ok)) {
    update.parsing_notes = clearReviewTags(resultNotes);
  }

  // Compare-and-set on the key and explanation read above: a concurrent save
  // (e.g. while the AI wrote the explanation) can't be overwritten.
  let write = db.from("questions").update(update).eq("id", id);
  write = prior.correct_answer === null ? write.is("correct_answer", null) : write.eq("correct_answer", prior.correct_answer);
  write = prior.explanation === null ? write.is("explanation", null) : write.eq("explanation", prior.explanation);
  const { data, error } = await write.select().maybeSingle();

  if (error) {
    console.error("[questions/PATCH] error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
  if (!data) return stale;

  const result = data;

  // Re-grade already-submitted work so scores/score reports reflect the
  // corrected key instead of the old one.
  if (answerChanged) {
    const exInfo = prepared
      ? { explanation: prepared.explanation.outcome, warning: keyExplanationWarning(prepared.live, prepared.explanation) ?? undefined }
      : {};
    try {
      const rescore = await rescoreQuestion(db, id);
      return NextResponse.json({ data: result, rescore, ...exInfo });
    } catch (e) {
      console.error("[questions/PATCH] rescore failed:", e);
      return NextResponse.json({ data: result, ...exInfo });
    }
  }

  return NextResponse.json({ data: result });
}
