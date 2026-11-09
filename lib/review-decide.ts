// lib/review-decide.ts
//
// What happens after a person makes the one decision the review queue asks
// for (/api/admin/review-queue/decide). Every action:
//   1. applies the decision (key, PDF version, re-extracted text…),
//   2. regenerates the explanation when the key or the content changed,
//   3. clears the notes the decision settled,
//   4. approves the question when nothing else blocks (approvalBlockers +
//      a checked explanation). Otherwise it stays in Needs Review and shows
//      up under its next reason.
// A status is never lowered. A content change to a question in a live test
// keeps it Approved and leads its notes with a [live-fix] sentence. Key changes go through lib/key-change.ts (the
// preview-then-confirm rescore flow).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifyNote,
  draftRejection,
  failingChecks,
  keyIsOfficial,
  type AutoFixRow,
} from "@/lib/explanation-autofix";
import {
  choicesWithStoredImages,
  regenDisagreeNote,
  regenerateExplanation,
  REGEN_DISAGREE_PREFIX,
} from "@/lib/ai/solve-question";
import { clearReviewTags } from "@/lib/key-doubt";
import { findApproveBlocker } from "@/lib/parse-guards";
import { applyKeyCorrection, keyExplanationWarning, type ExplainFn, type KeyCorrectionResult } from "@/lib/key-change";
import { loadProposal, proposalIsCurrent, replaceTableBlock, tableBlockCount } from "@/lib/figure-compare";
import { LIVE_FIX_TAG, liveQuestionIds } from "@/lib/live-questions";
import {
  changedFields,
  clearLiveFixSnapshot,
  loadLiveFixSnapshots,
  LIVE_FIX_CONFIRMED_PREFIX,
  LIVE_FIX_UNDONE_PREFIX,
  saveLiveFixSnapshot,
  snapshotValid,
  stripAllLiveFix,
  type SnapshotField,
} from "@/lib/live-fix";
import {
  approvalBlockers,
  dropFigureNotes,
  dropSettledNotes,
  EXPLANATION_CHECK_NOTE,
  STEM_REPLACED_PREFIX,
  figureProposalUrl,
  FIGURE_KEPT_PREFIX,
  FIGURE_USED_PDF_PREFIX,
  groupRow,
  isKeyQuestionNote,
  removeNotes,
  type ReviewGroupId,
} from "@/lib/review-queue";

export const DECIDE_SELECT =
  "id, module_id, original_question_number, section, question_type, question_text, choices, correct_answer, official_answer, explanation, parsing_status, parsing_notes, has_image, image_urls, image_alts, has_table, mismatch_with_official, updated_at";

type Row = AutoFixRow & { image_alts?: string[] | null; mismatch_with_official?: boolean | null };

export type DecideAction =
  | { action: "keep_key" }
  | { action: "set_key"; key: string; expectedKey: string | null; rescore: boolean }
  | { action: "use_pdf" }
  | { action: "keep_figure" }
  | { action: "use_pdf_text"; questionText: string }
  | { action: "regen_explanation" }
  | { action: "approve" }
  | { action: "confirm_live_fix" }
  /** `restoreKey`: the key before the live fix, after the rescore preview (rescore must be true). */
  | { action: "undo_live_fix"; restoreKey?: string | null; rescore?: boolean };

export interface DecideResult {
  ok: boolean;
  status?: number;
  error?: string;
  approved?: boolean;
  /** Why it is still in Needs Review (empty when approved). */
  blockers?: string[];
  /** The group it now falls in (null when approved). */
  nextGroup?: ReviewGroupId | null;
  explanation?: "kept" | "regenerated" | "failed" | "ai_disagrees";
  key?: KeyCorrectionResult;
  live?: boolean;
  /** Set when the key change went through but a later step didn't. */
  warning?: string;
}

const CONTENT_FIELDS = ["question_text", "choices", "explanation", "image_urls", "image_alts", "has_image"];

/** Leading note for a content change made while the question is in a live test. */
export function liveFixNotes(notes: string | null | undefined): string {
  const n = (notes ?? "").trim();
  if (n.startsWith(LIVE_FIX_TAG)) return n;
  return `${LIVE_FIX_TAG} Content changed from the review queue while this question is in a live test; kept Approved — please re-check.${n ? ` ${n}` : ""}`;
}

/** Is an Approved row in a live test? (A failed lookup counts as live.) */
async function isLive(db: SupabaseClient, row: Row): Promise<boolean> {
  if (row.parsing_status !== "Approved") return false;
  return (await liveQuestionIds(db, [row.id]).catch(() => new Set<string>([row.id]))).has(row.id);
}

async function loadRow(db: SupabaseClient, id: string): Promise<Row | null> {
  const { data } = await db.from("questions").select(DECIDE_SELECT).eq("id", id).maybeSingle();
  return (data as Row | null) ?? null;
}

/** Notes about the stem being cut off / the passage missing (settled by new text from the PDF). */
function isStemNote(seg: string): boolean {
  return (
    /question text looks cut off|stem (?:still )?truncated|AI re-read of the source PDF \(scanned page/i.test(seg) ||
    (/^Semantic audit:/i.test(seg) && /\bstem\b|passage/i.test(seg) && !/correct[_ ]answer|\bkey\b/i.test(seg))
  );
}

/**
 * Write a fresh explanation for the saved key. Saved only when it passes the
 * same checks as the auto-fix; an AI that answers differently gets the
 * "AI's own answer is …" note (a key decision for the queue).
 */
type Refresh = {
  explanation?: string;
  notes?: string | null;
  outcome: DecideResult["explanation"];
  /** The same note change applied to another copy of the row (a retry on a fresh row). */
  notesFor: (r: Row) => string | null | undefined;
};

async function refreshExplanation(row: Row, userId?: string, explain: ExplainFn = regenerateExplanation): Promise<Refresh> {
  const key = row.correct_answer ?? "";
  const none = { outcome: "failed" as const, notesFor: () => undefined };
  if (!key) return none;
  const res = await explain(
    {
      questionId: row.id,
      questionNumber: row.original_question_number,
      questionText: row.question_text ?? "",
      choices: choicesWithStoredImages(row.choices, row.choices),
      questionType: row.question_type,
      answer: key,
      imageUrls: Array.isArray(row.image_urls) ? (row.image_urls as string[]) : null,
    },
    userId,
    "review-queue",
  );
  if (!res.ok) return none;
  if (res.aiAnswer && !res.agrees && !(res.aiAnswer.length > 40 || res.aiAnswer.includes("\n"))) {
    const disagree = regenDisagreeNote(res.aiAnswer, key);
    const notesFor = (r: Row) => [removeNotes(r.parsing_notes, (s) => s.startsWith(REGEN_DISAGREE_PREFIX)).notes, disagree].filter(Boolean).join("; ");
    return { notes: notesFor(row), outcome: "ai_disagrees", notesFor };
  }
  // Written only after a solve that never saw the key agreed with it.
  if (res.independent === false || draftRejection(row, res.explanation)) return none;
  // The old explanation-problem notes are settled by the new explanation.
  const explanation = res.explanation;
  const notesFor = (r: Row) => {
    const ctx = { officialKey: keyIsOfficial(r), failingChecks: failingChecks(r, explanation) };
    return removeNotes(r.parsing_notes, (s) => classifyNote(s, ctx) === "explanation" || EXPLANATION_CHECK_NOTE.test(s)).notes;
  };
  return { explanation, notes: notesFor(row), outcome: "regenerated", notesFor };
}

/** Why the row can't be approved yet (approvalBlockers + an unchecked explanation). */
export function decideBlockers(row: AutoFixRow): string[] {
  const out = approvalBlockers(row);
  const ex = draftRejection(row, row.explanation ?? "");
  if (ex) out.push(`explanation: ${ex}`);
  return out;
}

/**
 * Whether a person may approve this row as it is ("Looks right"): only the
 * "ready" / "A note to resolve" / "Live-test re-check" reasons may be left. Returns the blockers
 * that stop it (empty = may approve).
 */
export function approveRefusal(row: AutoFixRow): string[] {
  const g = groupRow(row);
  const out: string[] = [];
  // Any blocker that isn't a note (approve check, missing figure, key ≠
  // official, failing check, unchecked explanation) always stops it.
  for (const b of decideBlockers(row)) if (!b.startsWith("note: ")) out.push(b);
  for (const r of g.reasons) if (r.group !== "ready" && r.group !== "note" && r.group !== "live_fix" && !out.some((b) => b.endsWith(r.text))) out.push(r.text);
  return out;
}

/** Apply `patch`, then approve when nothing else blocks. Status is never lowered. */
async function finish(
  db: SupabaseClient,
  before: Row,
  patch: Record<string, unknown>,
  userId: string | undefined,
  extra: Partial<DecideResult> = {},
  live = false,
  /** false: never approve (the key has no checked explanation). */
  allowApprove = true,
): Promise<DecideResult> {
  if (live && CONTENT_FIELDS.some((f) => f in patch)) {
    patch = { ...patch, parsing_notes: liveFixNotes("parsing_notes" in patch ? (patch.parsing_notes as string | null) : before.parsing_notes) };
    extra = { ...extra, live: true };
  }
  const next = { ...before, ...patch } as Row;
  const blockers = decideBlockers(next);
  const update: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  if (allowApprove && blockers.length === 0 && next.parsing_status !== "Approved") {
    update.parsing_status = "Approved";
    update.reviewed_by = userId ?? null;
    update.reviewed_at = new Date().toISOString();
    update.parsing_notes = clearReviewTags(next.parsing_notes);
  }
  delete (update as { id?: unknown }).id;
  let q = db.from("questions").update(update).eq("id", before.id);
  if (before.updated_at) q = q.eq("updated_at", before.updated_at);
  const { data, error } = await q.select("id");
  if (error) return { ok: false, status: 500, error: "Update failed" };
  if (!data?.length) return { ok: false, status: 409, error: "This question changed since the page loaded. Reload and try again." };
  // After the write went through: keep what students saw before, for the
  // live-fix group's before / after and Undo.
  if (extra.live && typeof update.parsing_notes === "string" && CONTENT_FIELDS.some((f) => f in patch)) {
    await saveLiveFixSnapshot(db, before as unknown as Record<string, unknown> & { id: string }, "review queue", update.parsing_notes);
  }
  const approved = allowApprove && (update.parsing_status === "Approved" || next.parsing_status === "Approved");
  const after = { ...next, ...update } as Row;
  return { ok: true, approved, blockers, nextGroup: approved ? null : groupRow(after).primary, ...extra };
}

export async function decide(
  db: SupabaseClient,
  id: string,
  act: DecideAction,
  opts: { userId?: string; userName?: string | null; expectedUpdatedAt?: string | null; explain?: ExplainFn },
): Promise<DecideResult> {
  let row = await loadRow(db, id);
  if (!row) return { ok: false, status: 404, error: "Question not found" };
  if (opts.expectedUpdatedAt && row.updated_at && opts.expectedUpdatedAt !== row.updated_at) {
    return { ok: false, status: 409, error: "This question changed since the page loaded. Reload and try again." };
  }

  switch (act.action) {
    case "keep_key":
    case "set_key": {
      const live = await isLive(db, row);
      // The person settled the key: drop the notes that disputed it. A key
      // other than the official one overrules it (as resolve-mismatch does).
      const keyPatch = (r: Row): Record<string, unknown> => {
        const patch: Record<string, unknown> = { parsing_notes: removeNotes(r.parsing_notes, (s) => isKeyQuestionNote(s, r.correct_answer)).notes };
        if (r.official_answer && !keyIsOfficial(r)) patch.official_answer = null;
        if (r.mismatch_with_official) patch.mismatch_with_official = false;
        return patch;
      };

      if (!(act.action === "set_key" && act.key.trim() !== (row.correct_answer ?? "").trim())) {
        const patch = keyPatch(row);
        const cur = { ...row, ...patch } as Row;
        let explanation: DecideResult["explanation"] = "kept";
        if (draftRejection(cur, cur.explanation ?? "")) {
          const ex = await refreshExplanation(cur, opts.userId, opts.explain);
          explanation = ex.outcome;
          if (ex.explanation) patch.explanation = ex.explanation;
          if (ex.notes !== undefined) patch.parsing_notes = ex.notes;
        }
        // The key stands, but without a checked explanation it is never
        // reported as approved.
        const exOk = explanation === "kept" || explanation === "regenerated";
        const res = await finish(db, row, patch, opts.userId, { explanation }, live, exOk);
        if (!exOk && res.ok) {
          return {
            ...res,
            approved: false,
            warning:
              explanation === "ai_disagrees"
                ? "Key kept, but solving it without the key the AI got another answer, so no explanation was written. Check the key."
                : "Key kept, but the explanation couldn't be rewritten and checked. Edit it by hand.",
          };
        }
        return res;
      }

      // The key is saved together with an explanation that was written from
      // an independent solve and checked (lib/key-change.ts). If none could
      // be, the key still stands but the question is NOT approved: it goes to
      // Needs Review (or, in a live test, stays Approved with the
      // explanation hidden and a [live-fix] note).
      const keyRes = await applyKeyCorrection(db, {
        id,
        correct_answer: act.key,
        expectedKey: act.expectedKey,
        rescore: act.rescore,
        userId: opts.userId,
        // The name goes into a note: no separators / brackets (lib/key-source.ts parses it).
        source: opts.userName && opts.userName.replace(/[;()[\]]/g, " ").trim() ? `${opts.userName.replace(/[;()[\]]/g, " ").replace(/\s+/g, " ").trim()} (review queue)` : "a reviewer (review queue)",
        explain: opts.explain,
      });
      if (!keyRes.ok) return { ok: false, status: keyRes.status, error: keyRes.error, key: keyRes };

      // The key changed and answers were rescored: from here on the result
      // is a success; a later step that fails only adds a warning.
      const exOk = keyRes.explanationOk;
      const outcome: DecideResult["explanation"] = keyRes.explanation?.outcome ?? "failed";
      const extra: Partial<DecideResult> = { key: keyRes, live: keyRes.live, explanation: outcome };
      const exWarning = keyExplanationWarning(keyRes.live, keyRes.explanation);
      const notUpdated = "Key changed and answers rescored, but the notes weren't updated. Reload and check the question.";
      // After a failure the notes this step wrote (why, AI's answer) stay:
      // only the official-answer columns are settled.
      const patchFor = (r: Row): Record<string, unknown> => {
        const patch = keyPatch(r);
        if (!exOk) delete patch.parsing_notes;
        return patch;
      };
      let fresh = await loadRow(db, id);
      if (!fresh) return { ok: true, approved: false, ...extra, warning: exWarning ?? notUpdated };
      // applyKeyCorrection already led the notes with [live-fix] for a live row.
      let res = await finish(db, fresh, patchFor(fresh), opts.userId, extra, keyRes.live, exOk);
      if (!res.ok && res.status === 409) {
        fresh = await loadRow(db, id);
        if (fresh) res = await finish(db, fresh, patchFor(fresh), opts.userId, extra, keyRes.live, exOk);
      }
      if (!res.ok) return { ok: true, approved: false, ...extra, warning: exWarning ?? notUpdated };
      if (!exOk) return { ...res, approved: false, warning: exWarning ?? undefined };
      return res;
    }

    case "use_pdf": {
      const url = figureProposalUrl(row.parsing_notes);
      const p = url ? await loadProposal(url) : null;
      if (!p || p.questionId !== id) return { ok: false, status: 400, error: "There is no PDF version to use for this question. Re-extract it instead." };
      if (p.checkMarkLeak) {
        return { ok: false, status: 400, error: "The PDF crop may show the ✓ answer mark, so it can't be used. Keep the stored figure or fix it by hand." };
      }
      if (!proposalIsCurrent(p, row)) {
        return { ok: false, status: 409, error: "The question changed since this comparison was made. Keep it, or run the figure check again." };
      }
      if (p.pdf.table && tableBlockCount(row.question_text) > 1) {
        return { ok: false, status: 400, error: "This question has more than one table; replace them by hand on the question page." };
      }
      const patch: Record<string, unknown> = {};
      if (p.pdf.choices?.length) {
        const stored = Array.isArray(row.choices) ? (row.choices as { label: string; image_url?: string | null }[]) : [];
        patch.choices = p.pdf.choices.map((c) => {
          const s = stored.find((x) => x.label === c.label);
          return s?.image_url ? { ...c, image_url: s.image_url } : c;
        });
      }
      if (p.pdf.table && row.question_text) patch.question_text = replaceTableBlock(row.question_text, p.pdf.table);
      if (p.pdf.imageUrls?.length) {
        patch.image_urls = p.pdf.imageUrls;
        patch.image_alts = p.pdf.imageAlts ?? [];
        patch.has_image = true;
      }
      if (Object.keys(patch).length === 0) return { ok: false, status: 400, error: "The PDF version is empty. Re-extract it instead." };
      const notes = dropFigureNotes(row.parsing_notes).notes;
      patch.parsing_notes = [notes, `${FIGURE_USED_PDF_PREFIX} (${p.parts.join(", ")}, ${new Date().toISOString().slice(0, 10)})`].filter(Boolean).join("; ");
      // New content: the explanation is rewritten (and checked) for it.
      const ex = await refreshExplanation({ ...row, ...patch } as Row, opts.userId, opts.explain);
      if (ex.explanation) patch.explanation = ex.explanation;
      if (ex.notes !== undefined) patch.parsing_notes = ex.notes;
      return finish(db, row, patch, opts.userId, { explanation: ex.outcome }, await isLive(db, row));
    }

    case "keep_figure": {
      const notes = dropFigureNotes(row.parsing_notes).notes;
      const patch = { parsing_notes: [notes, `${FIGURE_KEPT_PREFIX} (${new Date().toISOString().slice(0, 10)})`].filter(Boolean).join("; ") };
      return finish(db, row, patch, opts.userId);
    }

    case "use_pdf_text": {
      const text = act.questionText.trim();
      if (!text) return { ok: false, status: 400, error: "The re-extracted text is empty." };
      const patch: Record<string, unknown> = {
        question_text: text,
        parsing_notes: [removeNotes(row.parsing_notes, isStemNote).notes, `${STEM_REPLACED_PREFIX} (${new Date().toISOString().slice(0, 10)})`].filter(Boolean).join("; "),
      };
      const ex = await refreshExplanation({ ...row, ...patch } as Row, opts.userId, opts.explain);
      if (ex.explanation) patch.explanation = ex.explanation;
      if (ex.notes !== undefined) patch.parsing_notes = ex.notes;
      return finish(db, row, patch, opts.userId, { explanation: ex.outcome }, await isLive(db, row));
    }

    case "regen_explanation": {
      const ex = await refreshExplanation(row, opts.userId, opts.explain);
      const patch: Record<string, unknown> = {};
      if (ex.explanation) patch.explanation = ex.explanation;
      if (ex.notes !== undefined) patch.parsing_notes = ex.notes;
      if (ex.outcome === "failed") return { ok: false, status: 422, error: "Couldn't write a complete explanation that supports the key. Edit it by hand." };
      return finish(db, row, patch, opts.userId, { explanation: ex.outcome }, await isLive(db, row));
    }

    case "confirm_live_fix": {
      // A person compared before / after and the change stands.
      if (!(row.parsing_notes ?? "").startsWith(LIVE_FIX_TAG)) return { ok: false, status: 400, error: "This question has no live-test change to confirm." };
      const who = opts.userName ?? "a reviewer";
      const rest = stripAllLiveFix(row.parsing_notes);
      const patch: Record<string, unknown> = {
        parsing_notes: [rest, `${LIVE_FIX_CONFIRMED_PREFIX} ${who.replace(/[;()]/g, " ").trim()} (${new Date().toISOString().slice(0, 10)})`].filter(Boolean).join("; "),
      };
      if (row.parsing_status === "Approved") {
        patch.reviewed_by = opts.userId ?? null;
        patch.reviewed_at = new Date().toISOString();
      }
      const res = await finish(db, row, patch, opts.userId);
      if (res.ok) await clearLiveFixSnapshot(db, id).catch(() => undefined);
      return res;
    }

    case "undo_live_fix": {
      if (!(row.parsing_notes ?? "").startsWith(LIVE_FIX_TAG)) return { ok: false, status: 400, error: "This question has no live-test change to undo." };
      const snap = (await loadLiveFixSnapshots(db, [id])).get(id) ?? null;
      // Only the version recorded for THIS live-fix change can be put back.
      if (!snapshotValid(snap, row.parsing_notes)) return { ok: false, status: 400, error: "No earlier version was recorded for this change. Edit it by hand." };
      const changed = changedFields(snap, row as unknown as Record<string, unknown>);
      const keyBefore = "correct_answer" in snap.fields ? ((snap.fields.correct_answer as string | null) ?? null) : row.correct_answer ?? null;
      const keyChanged = changed.includes("correct_answer");
      const who = (opts.userName ?? "a reviewer").replace(/[;()]/g, " ").trim();
      let keyRes: KeyCorrectionResult | undefined;
      if (keyChanged) {
        // The key goes back only after the person saw who gets rescored.
        if (act.restoreKey !== keyBefore || act.rescore !== true) {
          return { ok: false, status: 409, error: `Undo changes the key back to ${keyBefore ?? "∅"}: confirm the rescoring preview first.` };
        }
        keyRes = await applyKeyCorrection(db, {
          id,
          correct_answer: keyBefore ?? "",
          expectedKey: row.correct_answer ?? null,
          rescore: true,
          userId: opts.userId,
          source: `${who} (undo of a live-test change)`,
        });
        if (!keyRes.ok) return { ok: false, status: keyRes.status, error: keyRes.error, key: keyRes };
        const fresh = await loadRow(db, id);
        if (!fresh) return { ok: true, approved: false, key: keyRes, warning: "Key restored; reload to check the rest." };
        row = fresh;
      }
      // Content back as it was (the explanation only when the key is unchanged:
      // a restored key comes with its own checked explanation).
      const fields = changed.filter((f): f is Exclude<SnapshotField, "correct_answer"> => f !== "correct_answer" && !(keyChanged && f === "explanation"));
      const patch: Record<string, unknown> = {};
      for (const f of fields) patch[f] = snap.fields[f];
      const explanationFailed = keyRes?.ok && !keyRes.explanationOk;
      // A restored key without a checked explanation keeps its [live-fix] note.
      const base = explanationFailed ? row.parsing_notes : stripAllLiveFix(row.parsing_notes);
      const what = [...fields, ...(keyChanged ? ["key"] : [])].map((f) => f.replace(/_/g, " ")).join(", ") || "nothing (it already matched)";
      patch.parsing_notes = [base, `${LIVE_FIX_UNDONE_PREFIX} ${who} (${new Date().toISOString().slice(0, 10)}): restored the earlier ${what}`].filter(Boolean).join("; ");
      // Never demoted: the status isn't touched. No blind retry (a concurrent
      // edit wins); after a restored (and rescored) key a failed content write
      // is reported as a warning — the key change stands.
      let q = db.from("questions").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
      if (row.updated_at) q = q.eq("updated_at", row.updated_at);
      const { data, error } = await q.select("id");
      if (error || !data?.length) {
        if (keyRes?.ok) {
          return { ok: true, approved: row.parsing_status === "Approved", key: keyRes, live: true, warning: `The key is back to ${keyBefore ?? "∅"} (answers rescored), but the earlier ${fields.map((f) => f.replace(/_/g, " ")).join(", ") || "content"} couldn't be put back: the question changed meanwhile. Reload and Undo again, or edit it by hand.` };
        }
        if (error) return { ok: false, status: 500, error: "Update failed" };
        return { ok: false, status: 409, error: "This question changed since the page loaded. Reload and try again." };
      }
      if (!explanationFailed) await clearLiveFixSnapshot(db, id).catch(() => undefined);
      return {
        ok: true,
        approved: row.parsing_status === "Approved",
        key: keyRes,
        live: true,
        warning: explanationFailed ? keyExplanationWarning(true, keyRes && keyRes.ok ? keyRes.explanation : null) ?? undefined : undefined,
      };
    }

    case "approve": {
      // A person checked it ("Looks right"): the same gate as the Approve
      // button, plus every blocker outside the Other / Live-test groups.
      const blocker = findApproveBlocker(row.question_text, row.choices, row.question_type, row.correct_answer ?? null, row.official_answer ?? null);
      if (blocker) return { ok: false, status: 400, error: `Can't approve: ${blocker.reason}.` };
      const refusal = approveRefusal(row);
      if (refusal.length > 0) {
        return { ok: false, status: 400, error: `Can't approve yet: ${refusal[0].replace(/^note: /, "")}`, blockers: refusal, nextGroup: groupRow(row).primary };
      }
      const update: Record<string, unknown> = {
        parsing_status: "Approved",
        parsing_notes: clearReviewTags(dropSettledNotes(row).notes),
        reviewed_by: opts.userId ?? null,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      let q = db.from("questions").update(update).eq("id", id);
      if (row.updated_at) q = q.eq("updated_at", row.updated_at);
      const { data, error } = await q.select("id");
      if (error) return { ok: false, status: 500, error: "Update failed" };
      if (!data?.length) return { ok: false, status: 409, error: "This question changed since the page loaded. Reload and try again." };
      return { ok: true, approved: true, blockers: [], nextGroup: null };
    }
  }
}
