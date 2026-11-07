// lib/key-change.ts
//
// One answer-key / type correction AFTER the person saw the rescore preview
// (lib/key-check.ts previewKeyChange). Shared by the key-check page
// (/api/admin/key-check/apply) and the review queue
// (/api/admin/review-queue/decide).
//
//   - `expectedKey` is the key the preview was made for (409 if it changed).
//   - A key change needs `rescore: true` (the explicit confirm on the
//     preview); graded answers are never rescored silently.
//   - The status is never lowered: a question in a live test stays Approved
//     and gets a [live-fix] note; any other question keeps its status.
//   - Notes about the OLD key (consensus, semantic audit, "stored X", key
//     doubts…) are dropped (lib/review-queue.ts dropStaleKeyNotes).
//   - The explanation is rewritten for the new key, then answers are rescored.

import type { SupabaseClient } from "@supabase/supabase-js";
import { KEY_FORM_NOTE_PREFIX, keyTypeProblem } from "@/lib/answer-key";
import { LIVE_FIX_TAG, liveQuestionIds, stripLiveFixNote } from "@/lib/live-questions";
import { explainOneAnswer } from "@/lib/ai/solve-question";
import { rescoreQuestion, type RescoreResult } from "@/lib/rescore";
import { dropStaleKeyNotes } from "@/lib/review-queue";

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
  /** Rewrite the explanation for a new key here (default true). */
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
      explanationUpdated: boolean;
      rescore: RescoreResult | null;
      rescoreError?: string;
    };

export async function applyKeyCorrection(db: SupabaseClient, input: KeyCorrectionInput): Promise<KeyCorrectionResult> {
  const { data: q } = await db
    .from("questions")
    .select("id, question_text, choices, question_type, correct_answer, parsing_status, parsing_notes")
    .eq("id", input.id)
    .maybeSingle();
  if (!q) return { ok: false, status: 404, error: "Question not found" };
  if ((q.correct_answer ?? null) !== (input.expectedKey ?? null)) {
    return { ok: false, status: 409, error: "The key changed since the preview. Reload the page and preview again." };
  }

  const oldKey = (q.correct_answer as string | null) ?? null;
  const nextType = typeof input.question_type === "string" ? input.question_type : (q.question_type as string | null);
  const nextKey = typeof input.correct_answer === "string" ? input.correct_answer.trim() : oldKey;
  const nextChoices = input.clear_choices || nextType === "Student Produced Response" ? [] : q.choices;
  const problem = keyTypeProblem({ question_type: nextType, correct_answer: nextKey, question_text: q.question_text as string | null, choices: nextChoices });
  if (problem) return { ok: false, status: 400, error: `This correction still doesn't fit: ${problem.reason}.` };
  const keyChanged = (oldKey ?? "") !== (nextKey ?? "");
  if (keyChanged && input.rescore !== true) {
    return { ok: false, status: 400, error: "Changing the key needs the rescoring confirm from the preview." };
  }

  const live = q.parsing_status === "Approved" ? (await liveQuestionIds(db, [input.id])).has(input.id) : false;
  const changes = [
    nextType !== q.question_type ? `type ${q.question_type ?? "∅"} → ${nextType}` : null,
    keyChanged ? `key ${oldKey ?? "∅"} → ${nextKey}` : null,
    Array.isArray(q.choices) && q.choices.length > 0 && (nextChoices as unknown[]).length === 0 ? "choices removed" : null,
  ].filter(Boolean);
  const withoutStale = dropStaleKeyNotes(stripLiveFixNote((q.parsing_notes as string | null) ?? ""), oldKey, nextKey).notes ?? "";
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

  // Compare-and-set on the key the preview was made for: of two concurrent
  // changes only one writes (and rescores); the other gets a 409.
  let upd = db
    .from("questions")
    .update({
      question_type: nextType,
      correct_answer: nextKey,
      choices: nextChoices,
      parsing_notes: notes || null,
      updated_at: new Date().toISOString(),
    })
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

  // The old explanation argued the old key: write one for the new key.
  let explanationUpdated = false;
  if (keyChanged && nextKey && input.regenerateExplanation !== false) {
    try {
      explanationUpdated = !!(await explainOneAnswer(input.id, nextKey, db, input.userId));
    } catch (e) {
      console.error("[key-change] explanation regen failed:", e);
    }
  }

  let rescore: RescoreResult | null = null;
  if (keyChanged) {
    try {
      rescore = await rescoreQuestion(db, input.id);
    } catch (e) {
      console.error("[key-change] rescore failed:", e);
      return { ok: true, live, keyChanged, oldKey, newKey: nextKey, explanationUpdated, rescore: null, rescoreError: "Rescoring failed — run it again from the question page." };
    }
  }
  return { ok: true, live, keyChanged, oldKey, newKey: nextKey, explanationUpdated, rescore };
}
