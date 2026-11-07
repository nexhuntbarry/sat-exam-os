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
// A status is never lowered. Key changes go through lib/key-change.ts (the
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
import { applyKeyCorrection, type KeyCorrectionResult } from "@/lib/key-change";
import { loadProposal, replaceTableBlock } from "@/lib/figure-compare";
import {
  approvalBlockers,
  dropFigureNotes,
  figureProposalUrl,
  FIGURE_KEPT_PREFIX,
  FIGURE_USED_PDF_PREFIX,
  groupRow,
  isKeyQuestionNote,
  noteSegments,
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
  | { action: "approve" };

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
async function refreshExplanation(row: Row, userId?: string): Promise<{ explanation?: string; notes?: string | null; outcome: DecideResult["explanation"] }> {
  const key = row.correct_answer ?? "";
  if (!key) return { outcome: "failed" };
  const res = await regenerateExplanation(
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
  if (!res.ok) return { outcome: "failed" };
  if (res.aiAnswer && !res.agrees && !(res.aiAnswer.length > 40 || res.aiAnswer.includes("\n"))) {
    const notes = [...noteSegments(row.parsing_notes).filter((s) => !s.startsWith(REGEN_DISAGREE_PREFIX)), regenDisagreeNote(res.aiAnswer, key)].join("; ");
    return { notes, outcome: "ai_disagrees" };
  }
  if (draftRejection(row, res.explanation)) return { outcome: "failed" };
  // The old explanation-problem notes are settled by the new explanation.
  const ctx = { officialKey: keyIsOfficial(row), failingChecks: failingChecks(row, res.explanation) };
  const notes = removeNotes(row.parsing_notes, (s) => classifyNote(s, ctx) === "explanation").notes;
  return { explanation: res.explanation, notes, outcome: "regenerated" };
}

/** Why the row can't be approved yet (approvalBlockers + an unchecked explanation). */
export function decideBlockers(row: AutoFixRow): string[] {
  const out = approvalBlockers(row);
  const ex = draftRejection(row, row.explanation ?? "");
  if (ex) out.push(`explanation: ${ex}`);
  return out;
}

/** Apply `patch`, then approve when nothing else blocks. Status is never lowered. */
async function finish(
  db: SupabaseClient,
  before: Row,
  patch: Record<string, unknown>,
  userId: string | undefined,
  extra: Partial<DecideResult> = {},
): Promise<DecideResult> {
  const next = { ...before, ...patch } as Row;
  const blockers = decideBlockers(next);
  const update: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  if (blockers.length === 0 && next.parsing_status !== "Approved") {
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
  const approved = update.parsing_status === "Approved" || next.parsing_status === "Approved";
  const after = { ...next, ...update } as Row;
  return { ok: true, approved, blockers, nextGroup: approved ? null : groupRow(after).primary, ...extra };
}

export async function decide(
  db: SupabaseClient,
  id: string,
  act: DecideAction,
  opts: { userId?: string; expectedUpdatedAt?: string | null },
): Promise<DecideResult> {
  let row = await loadRow(db, id);
  if (!row) return { ok: false, status: 404, error: "Question not found" };
  if (opts.expectedUpdatedAt && row.updated_at && opts.expectedUpdatedAt !== row.updated_at && act.action !== "set_key") {
    return { ok: false, status: 409, error: "This question changed since the page loaded. Reload and try again." };
  }

  switch (act.action) {
    case "keep_key":
    case "set_key": {
      let keyRes: KeyCorrectionResult | undefined;
      if (act.action === "set_key" && act.key.trim() !== (row.correct_answer ?? "").trim()) {
        keyRes = await applyKeyCorrection(db, {
          id,
          correct_answer: act.key,
          expectedKey: act.expectedKey,
          rescore: act.rescore,
          userId: opts.userId,
          source: "a reviewer (review queue)",
          // Written below with the checked regenerateExplanation instead.
          regenerateExplanation: false,
        });
        if (!keyRes.ok) return { ok: false, status: keyRes.status, error: keyRes.error, key: keyRes };
        row = (await loadRow(db, id))!;
      }
      // The person settled the key: drop the notes that questioned it. A key
      // other than the official one overrules it (as resolve-mismatch does).
      const patch: Record<string, unknown> = {
        parsing_notes: removeNotes(row.parsing_notes, (s) => isKeyQuestionNote(s, row!.correct_answer)).notes,
      };
      if (row.official_answer && !keyIsOfficial(row)) patch.official_answer = null;
      if (row.mismatch_with_official) patch.mismatch_with_official = false;
      const cur = { ...row, ...patch } as Row;
      let explanation: DecideResult["explanation"] = "kept";
      if (keyRes?.ok || draftRejection(cur, cur.explanation ?? "")) {
        const ex = await refreshExplanation(cur, opts.userId);
        explanation = ex.outcome;
        if (ex.explanation) patch.explanation = ex.explanation;
        if (ex.notes !== undefined) patch.parsing_notes = ex.notes;
      }
      return finish(db, row, patch, opts.userId, { explanation, key: keyRes, live: keyRes?.ok ? keyRes.live : undefined });
    }

    case "use_pdf": {
      const url = figureProposalUrl(row.parsing_notes);
      const p = url ? await loadProposal(url) : null;
      if (!p || p.questionId !== id) return { ok: false, status: 400, error: "There is no PDF version to use for this question. Re-extract it instead." };
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
      const ex = await refreshExplanation({ ...row, ...patch } as Row, opts.userId);
      if (ex.explanation) patch.explanation = ex.explanation;
      if (ex.notes !== undefined) patch.parsing_notes = ex.notes;
      return finish(db, row, patch, opts.userId, { explanation: ex.outcome });
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
        parsing_notes: [removeNotes(row.parsing_notes, isStemNote).notes, `Question text replaced from the PDF by a reviewer (${new Date().toISOString().slice(0, 10)})`].filter(Boolean).join("; "),
      };
      const ex = await refreshExplanation({ ...row, ...patch } as Row, opts.userId);
      if (ex.explanation) patch.explanation = ex.explanation;
      if (ex.notes !== undefined) patch.parsing_notes = ex.notes;
      return finish(db, row, patch, opts.userId, { explanation: ex.outcome });
    }

    case "regen_explanation": {
      const ex = await refreshExplanation(row, opts.userId);
      const patch: Record<string, unknown> = {};
      if (ex.explanation) patch.explanation = ex.explanation;
      if (ex.notes !== undefined) patch.parsing_notes = ex.notes;
      if (ex.outcome === "failed") return { ok: false, status: 422, error: "Couldn't write a complete explanation that supports the key. Edit it by hand." };
      return finish(db, row, patch, opts.userId, { explanation: ex.outcome });
    }

    case "approve": {
      // A person checked it ("Looks right"): the same gate as the Approve button.
      const blocker = findApproveBlocker(row.question_text, row.choices, row.question_type, row.correct_answer ?? null, row.official_answer ?? null);
      if (blocker) return { ok: false, status: 400, error: `Can't approve: ${blocker.reason}.` };
      const update: Record<string, unknown> = {
        parsing_status: "Approved",
        parsing_notes: clearReviewTags(row.parsing_notes),
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
