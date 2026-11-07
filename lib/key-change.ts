// lib/key-change.ts
//
// THE path for an answer-key change, from any source: the review queue
// (lib/review-decide.ts), the key-check page (/api/admin/key-check/apply),
// a reviewer's edit (PATCH /api/admin/questions/[id]), resolve-mismatch,
// the AI-key verifier (lib/verify-ai-key.ts) and scripts.
//
// A new key is saved TOGETHER with an explanation written and checked for
// it (incident 2026-11-07, [Test #14] J Test Math M1 Q10: the key went
// B → A, the regeneration failed, and the old explanation, "… = 120%. Only
// choice B is correct", stayed behind the new key while the queue said
// "approved"):
//   1. explanationForKey: the AI solves the question WITHOUT the key, then
//      writes the explanation only if it reaches the same answer
//      (lib/ai/solve-question.ts regenerateExplanation). The draft must pass
//      draftRejection — cut off, formatting, another letter, and the numeric
//      consistency check (lib/explanation-consistency.ts).
//   2. keyExplanationPatch: on success the explanation is saved with the key.
//      On failure the key is still saved, but NO stale explanation stays:
//        - not in a live test → Needs Review, explanation removed (unless the
//          current one already passes every check for the new key), a note
//          says why;
//        - in a live test → stays Approved (never pulled from students), the
//          explanation is hidden (null) unless the current one passes every
//          check for the new key, and a [live-fix] note leads.
//      The caller must never report "approved" after a failure.
//
// applyKeyCorrection (preview-then-confirm flow):
//   - `expectedKey` is the key the preview was made for (409 if it changed).
//   - A key change needs `rescore: true` (the explicit confirm on the
//     preview); graded answers are never rescored silently.
//   - The status is never lowered for a live-test question.
//   - Notes about the OLD key are dropped (lib/review-queue.ts dropStaleKeyNotes).

import type { SupabaseClient } from "@supabase/supabase-js";
import { KEY_FORM_NOTE_PREFIX, keyTypeProblem } from "@/lib/answer-key";
import { LIVE_FIX_TAG, liveQuestionIds, stripLiveFixNote } from "@/lib/live-questions";
import {
  regenDisagreeNote,
  regenerateExplanation,
  REGEN_DISAGREE_PREFIX,
  type RegenExplanationInput,
  type RegenExplanationResult,
} from "@/lib/ai/solve-question";
import { rescoreQuestion, type RescoreResult } from "@/lib/rescore";
import { highResFigure } from "@/lib/figure-hires";
import { dropStaleKeyNotes, EXPLANATION_CHECK_NOTE, removeNotes } from "@/lib/review-queue";
import { classifyNote, draftRejection, keyIsOfficial, failingChecks, TOO_LONG_PREFIX, type AutoFixRow } from "@/lib/explanation-autofix";

// ── Explanation for a key ────────────────────────────────────────────

export const KEY_EXPLANATION_FAILED_PREFIX = "Needs review: no checked explanation for the new key";

export type ExplainFn = (input: RegenExplanationInput, callerUserId?: string, usageRoute?: string) => Promise<RegenExplanationResult>;

export type KeyExplanationOutcome = "regenerated" | "kept" | "ai_disagrees" | "failed";

export interface KeyExplanation {
  outcome: KeyExplanationOutcome;
  /** The checked explanation to save (regenerated / kept). */
  explanation: string | null;
  /** The AI's independent answer (when it gave one). */
  aiAnswer: string | null;
  /** Why it failed (null on success). */
  reason: string | null;
}

export const explanationOk = (e: Pick<KeyExplanation, "outcome">) => e.outcome === "regenerated" || e.outcome === "kept";

export interface ExplanationOptions {
  userId?: string;
  route?: string;
  /** Injected for tests (default: regenerateExplanation). */
  explain?: ExplainFn;
  /**
   * Keep the row's current explanation when it already passes every check
   * for the key. Only for text a reviewer just supplied, or when the key did
   * not change — never for text written for an old key.
   */
  keepCurrent?: boolean;
  /** The key is being changed (default true): old text is never kept on a failure. */
  keyChanged?: boolean;
}

/**
 * Write and check an explanation for `key` on `row` (the content as it will
 * be saved). Two attempts; an AI that reaches another answer stops it.
 */
export async function explanationForKey(row: AutoFixRow, key: string, opts: ExplanationOptions = {}): Promise<KeyExplanation> {
  const target: AutoFixRow = { ...row, correct_answer: key };
  const current = (row.explanation ?? "").trim();
  if (opts.keepCurrent && current && !draftRejection(target, current)) {
    return { outcome: "kept", explanation: row.explanation, aiAnswer: null, reason: null };
  }
  const explain = opts.explain ?? regenerateExplanation;
  const input: RegenExplanationInput = {
    questionId: row.id,
    questionNumber: row.original_question_number,
    questionText: row.question_text ?? "",
    choices: row.choices,
    questionType: row.question_type,
    answer: key,
    imageUrls: Array.isArray(row.image_urls) ? (row.image_urls as string[]) : null,
  };
  // The high-resolution figure re-read costs an AI call: once per key change,
  // shared by every attempt.
  if (Array.isArray(row.image_urls) && row.image_urls.length > 0 && !opts.explain) {
    input.hires = await highResFigure(row.id, opts.userId);
  }
  let reason = "the AI call failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: RegenExplanationResult;
    try {
      res = await explain(input, opts.userId, opts.route ?? "key-change");
    } catch (e) {
      reason = `the AI call failed (${e instanceof Error ? e.message.slice(0, 80) : "error"})`;
      continue;
    }
    if (!res.ok) {
      // A figure read that a second read contradicts is a finding, not a fluke: no retry.
      if (res.kind === "figure_conflict") return { outcome: "failed", explanation: null, aiAnswer: null, reason: res.error };
      reason = res.kind === "cut_off" ? "the explanation kept coming out cut off" : "the AI call failed";
      continue;
    }
    if (!res.agrees && res.aiAnswer && res.aiAnswer.length <= 40 && !res.aiAnswer.includes("\n")) {
      return { outcome: "ai_disagrees", explanation: null, aiAnswer: res.aiAnswer, reason: `solving it without the key, the AI got ${res.aiAnswer}` };
    }
    // The answer must come from a solve that never saw the key.
    if (!res.aiAnswer || res.independent === false || res.aiAnswer.length > 40 || res.aiAnswer.includes("\n")) {
      reason = "the AI gave no independent answer to compare with the key";
      continue;
    }
    const rejected = draftRejection(target, res.explanation);
    if (rejected) {
      reason = `the new explanation failed its check: ${rejected}`;
      continue;
    }
    return { outcome: "regenerated", explanation: res.explanation, aiAnswer: res.aiAnswer, reason: null };
  }
  return { outcome: "failed", explanation: null, aiAnswer: null, reason };
}

const noteSafe = (s: string) => s.replace(/;/g, ",").replace(/\s+/g, " ").trim();

export function keyExplanationFailedNote(key: string, reason: string): string {
  return `${KEY_EXPLANATION_FAILED_PREFIX} ${noteSafe(key)} (${noteSafe(reason).replace(/[()]/g, "")}) — write and check it by hand`;
}

/** Notes this step owns (replaced on every run). */
const isOwnNote = (s: string) => s.startsWith(KEY_EXPLANATION_FAILED_PREFIX) || s.startsWith(REGEN_DISAGREE_PREFIX);

export interface KeyExplanationPatch {
  /** Columns to merge into the caller's update (explanation, parsing_notes, maybe parsing_status). */
  patch: Record<string, unknown>;
  ok: boolean;
}

/**
 * Pure: what to save with the new key. `row` is the row as the caller will
 * save it (new key, new notes); `row.explanation` is the current text.
 */
export function keyExplanationPatch(row: AutoFixRow, ex: KeyExplanation, live: boolean, keyChanged = true): KeyExplanationPatch {
  const key = (row.correct_answer ?? "").trim();
  if (explanationOk(ex) && ex.explanation) {
    const explanation = ex.explanation;
    const ctx = { officialKey: keyIsOfficial(row), failingChecks: failingChecks(row, explanation) };
    // The explanation-problem notes are settled by the checked explanation.
    const notes = removeNotes(row.parsing_notes, (s) => isOwnNote(s) || classifyNote(s, ctx) === "explanation" || EXPLANATION_CHECK_NOTE.test(s)).notes;
    return { patch: { explanation, parsing_notes: notes }, ok: true };
  }
  // Failure: keep the key, never a stale explanation. After a real key
  // change the current text was written for the OLD key — the checks can
  // miss how it argues ("which matches option B"), so it always goes.
  // With the key unchanged, a current text that passes every check (length
  // aside: long but correct beats nothing) stays.
  const current = (row.explanation ?? "").trim();
  const rejected = current ? draftRejection(row, current) : "empty";
  const currentFits = !keyChanged && !!current && (!rejected || rejected.startsWith(`formatting: ${TOO_LONG_PREFIX}`));
  const patch: Record<string, unknown> = {};
  if (!currentFits) patch.explanation = null;
  const note =
    ex.outcome === "ai_disagrees" && ex.aiAnswer
      ? regenDisagreeNote(ex.aiAnswer, key)
      : keyExplanationFailedNote(key, ex.reason ?? (key ? "unknown" : "the key is empty"));
  // This step's live-fix sentence replaces any earlier one.
  const rest = removeNotes(stripLiveFixNote(row.parsing_notes), isOwnNote).notes;
  const body = [rest, note].filter(Boolean).join("; ");
  if (live) {
    // Students keep the question; they don't see an explanation that may be wrong.
    const what = currentFits ? "the current explanation still fits it" : "the explanation is hidden from students";
    patch.parsing_notes = `${LIVE_FIX_TAG} Key changed while this question is in a live test, but no new explanation passed the checks (${what}); kept Approved — please re-check. ${body}`.trim();
  } else {
    patch.parsing_notes = body;
    // A question whose current explanation still fits keeps its status.
    if (!currentFits && row.parsing_status !== "Rejected") patch.parsing_status = "Needs Review";
  }
  return { patch, ok: false };
}

/** Is this Approved question in a live test? (A failed lookup counts as live.) */
export async function isLiveQuestion(db: SupabaseClient, id: string, status: string | null | undefined): Promise<boolean> {
  if (status !== "Approved") return false;
  return (await liveQuestionIds(db, [id]).catch(() => new Set<string>([id]))).has(id);
}

export interface PreparedKeyChange extends KeyExplanationPatch {
  explanation: KeyExplanation;
  live: boolean;
}

/**
 * The one function every key change goes through: writes + checks the
 * explanation for `row.correct_answer` and returns the columns to save in
 * the SAME update as the key.
 */
export async function prepareKeyChange(
  db: SupabaseClient,
  row: AutoFixRow,
  opts: ExplanationOptions & { live?: boolean } = {},
): Promise<PreparedKeyChange> {
  const live = opts.live ?? (await isLiveQuestion(db, row.id, row.parsing_status));
  const key = (row.correct_answer ?? "").trim();
  const explanation: KeyExplanation = key
    ? await explanationForKey(row, key, opts)
    : { outcome: "failed", explanation: null, aiAnswer: null, reason: "the key is empty" };
  return { ...keyExplanationPatch(row, explanation, live, opts.keyChanged !== false), explanation, live };
}

export const KEY_ROW_SELECT =
  "id, module_id, original_question_number, section, question_type, question_text, choices, correct_answer, official_answer, explanation, parsing_status, parsing_notes, has_image, image_urls, has_table, updated_at";

/**
 * For a key that is already saved (scripts, the bank scan): write + check its
 * explanation now. Compare-and-set on the key and updated_at.
 */
export async function settleExplanationForKey(
  db: SupabaseClient,
  id: string,
  opts: ExplanationOptions & { live?: boolean } = {},
): Promise<{ ok: boolean; written: boolean; prepared: PreparedKeyChange | null; error?: string }> {
  const { data } = await db.from("questions").select(KEY_ROW_SELECT).eq("id", id).maybeSingle();
  if (!data) return { ok: false, written: false, prepared: null, error: "Question not found" };
  const row = data as AutoFixRow;
  // The key is already saved: its current text may stay if it passes.
  const prepared = await prepareKeyChange(db, row, { keyChanged: false, ...opts });
  let q = db
    .from("questions")
    .update({ ...prepared.patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  q = row.correct_answer === null ? q.is("correct_answer", null) : q.eq("correct_answer", row.correct_answer);
  if (row.updated_at) q = q.eq("updated_at", row.updated_at);
  const { data: w, error } = await q.select("id");
  if (error) return { ok: false, written: false, prepared, error: error.message };
  if (!w?.length) return { ok: false, written: false, prepared, error: "row changed since it was read" };
  return { ok: prepared.ok, written: true, prepared };
}

// ── Preview-then-confirm key correction ──────────────────────────────

export interface KeyCorrectionInput {
  id: string;
  correct_answer?: string;
  question_type?: string;
  clear_choices?: boolean;
  /** The key shown on the preview. */
  expectedKey: string | null;
  /** The person confirmed rescoring on the preview. */
  rescore: boolean;
  userId?: string;
  /** Who applied it, for the history note. */
  source: string;
  /** Injected for tests (default: regenerateExplanation). */
  explain?: ExplainFn;
  /** Automatic callers: refuse (409) when the question is in a live test right now. */
  refuseLive?: boolean;
  /** @deprecated Ignored: a new key is always saved with a checked explanation (or none). */
  regenerateExplanation?: boolean;
}

export type KeyCorrectionResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      live: boolean;
      keyChanged: boolean;
      oldKey: string | null;
      newKey: string | null;
      /** A new checked explanation was saved with the key. */
      explanationUpdated: boolean;
      /** The key has a checked explanation (false: Needs Review / hidden on a live question). */
      explanationOk: boolean;
      explanation: KeyExplanation | null;
      rescore: RescoreResult | null;
      rescoreError?: string;
    };

export async function applyKeyCorrection(db: SupabaseClient, input: KeyCorrectionInput): Promise<KeyCorrectionResult> {
  const { data } = await db.from("questions").select(KEY_ROW_SELECT).eq("id", input.id).maybeSingle();
  const q = data as AutoFixRow | null;
  if (!q) return { ok: false, status: 404, error: "Question not found" };
  if ((q.correct_answer ?? null) !== (input.expectedKey ?? null)) {
    return { ok: false, status: 409, error: "The key changed since the preview. Reload the page and preview again." };
  }

  const oldKey = q.correct_answer ?? null;
  const nextType = typeof input.question_type === "string" ? input.question_type : q.question_type;
  const nextKey = typeof input.correct_answer === "string" ? input.correct_answer.trim() : oldKey;
  const nextChoices = input.clear_choices || nextType === "Student Produced Response" ? [] : q.choices;
  const problem = keyTypeProblem({ question_type: nextType, correct_answer: nextKey, question_text: q.question_text, choices: nextChoices });
  if (problem) return { ok: false, status: 400, error: `This correction still doesn't fit: ${problem.reason}.` };
  const keyChanged = (oldKey ?? "") !== (nextKey ?? "");
  if (keyChanged && input.rescore !== true) {
    return { ok: false, status: 400, error: "Changing the key needs the rescoring confirm from the preview." };
  }

  const live = q.parsing_status === "Approved" ? (await liveQuestionIds(db, [input.id])).has(input.id) : false;
  if (live && input.refuseLive) {
    return { ok: false, status: 409, error: "This question is in a live test now — an automatic key change is not applied; it is queued for a person." };
  }
  const changes = [
    nextType !== q.question_type ? `type ${q.question_type ?? "∅"} → ${nextType}` : null,
    keyChanged ? `key ${oldKey ?? "∅"} → ${nextKey}` : null,
    Array.isArray(q.choices) && q.choices.length > 0 && (nextChoices as unknown[]).length === 0 ? "choices removed" : null,
  ].filter(Boolean);
  const withoutStale = dropStaleKeyNotes(stripLiveFixNote(q.parsing_notes ?? ""), oldKey, nextKey).notes ?? "";
  const kept = withoutStale
    .split(/;\s*/)
    .filter((s) => s && !s.startsWith(KEY_FORM_NOTE_PREFIX))
    .join("; ");
  const fixNote = `Answer key check: ${changes.join(", ")} (applied by ${input.source})`;
  // Notes are "; "-separated; the [live-fix] sentence leads (the format
  // stripLiveFixNote expects). An identical fix note isn't added twice.
  const noteBody = [...(kept ? kept.split(/;\s*/) : []), ...(changes.length ? [fixNote] : [])]
    .filter((s, i, all) => s && all.indexOf(s) === i)
    .join("; ");
  const notes = live
    ? `${LIVE_FIX_TAG} Key/type corrected while this question is in a live test; kept Approved — please re-check. ${noteBody}`
    : noteBody;

  const update: Record<string, unknown> = {
    question_type: nextType,
    correct_answer: nextKey,
    choices: nextChoices,
    parsing_notes: notes || null,
  };
  // The old explanation argued the old key: the new key is saved only
  // together with a checked explanation for it (or none at all).
  let prepared: PreparedKeyChange | null = null;
  if (keyChanged) {
    prepared = await prepareKeyChange(
      db,
      { ...q, question_type: nextType, correct_answer: nextKey, choices: nextChoices, parsing_notes: notes || null },
      { live, userId: input.userId, route: "key-change", explain: input.explain },
    );
    Object.assign(update, prepared.patch);
  }

  // Compare-and-set on the key the preview was made for: of two concurrent
  // changes only one writes (and rescores); the other gets a 409.
  let upd = db
    .from("questions")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", input.id);
  upd = oldKey === null ? upd.is("correct_answer", null) : upd.eq("correct_answer", oldKey);
  const { data: written, error } = await upd.select("id");
  if (error) {
    console.error("[key-change] update error:", error);
    return { ok: false, status: 500, error: "Update failed" };
  }
  if (!written?.length) {
    return { ok: false, status: 409, error: "The key changed since the preview. Reload the page and preview again." };
  }

  const explanationUpdated = prepared?.explanation.outcome === "regenerated";
  const exOk = prepared ? prepared.ok : true;
  const common = { live, keyChanged, oldKey, newKey: nextKey, explanationUpdated, explanationOk: exOk, explanation: prepared?.explanation ?? null };
  let rescore: RescoreResult | null = null;
  if (keyChanged) {
    try {
      rescore = await rescoreQuestion(db, input.id);
    } catch (e) {
      console.error("[key-change] rescore failed:", e);
      return { ok: true, ...common, rescore: null, rescoreError: "Rescoring failed — run it again from the question page." };
    }
  }
  return { ok: true, ...common, rescore };
}

/** One-line message for an admin after a key change whose explanation failed (null when it didn't). */
export function keyExplanationWarning(live: boolean, ex: KeyExplanation | null): string | null {
  if (!ex || explanationOk(ex)) return null;
  const why = ex.outcome === "ai_disagrees" ? `solving it without the key, the AI got ${ex.aiAnswer}` : ex.reason ?? "it failed its checks";
  return live
    ? `Key saved, but no checked explanation could be written (${why}). The question stays Approved in its live test; students don't see an explanation that may be wrong — write one by hand.`
    : `Key saved, but no checked explanation could be written (${why}). The question was moved to Needs Review — write the explanation by hand or check the key.`;
}
