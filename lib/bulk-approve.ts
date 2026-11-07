// lib/bulk-approve.ts
//
// Pure planning step for POST /api/admin/questions/bulk-approve: which rows
// get approved and which are held in review (with what update). Kept out of
// the route so it can be tested without a request.

import { findApproveBlocker } from "@/lib/parse-guards";
import { applyLiveHold } from "@/lib/live-questions";

/** Only these statuses are ever touched by Bulk Approve. */
export const BULK_APPROVE_STATUSES = ["Draft", "Needs Review"] as const;

export interface BulkApproveRow {
  id: string;
  question_text: string | null;
  choices: unknown;
  question_type: string | null;
  correct_answer: string | null;
  parsing_status: string | null;
  parsing_notes: string | null;
}

export interface BulkApprovePlan {
  /** Rows with no blocker — approve these. */
  clean: string[];
  /** Rows with a blocker — write `update` to each. */
  holds: { id: string; update: Record<string, unknown> }[];
  /** Rows not touched at all (already Approved, Rejected, …). */
  skipped: string[];
}

/**
 * Rows whose stem/choices carry parser placeholder text, look cut off, or
 * whose key doesn't fit the type stay in (or move to) Needs Review with a
 * note. Rows outside Draft / Needs Review are skipped untouched, and every
 * hold goes through applyLiveHold so a live question is never demoted.
 */
export function planBulkApprove(rows: BulkApproveRow[], live: Set<string>, now: string): BulkApprovePlan {
  const plan: BulkApprovePlan = { clean: [], holds: [], skipped: [] };
  for (const r of rows) {
    if (!(BULK_APPROVE_STATUSES as readonly (string | null)[]).includes(r.parsing_status)) {
      plan.skipped.push(r.id);
      continue;
    }
    const blocker = findApproveBlocker(r.question_text, r.choices, r.question_type, r.correct_answer);
    if (!blocker) {
      plan.clean.push(r.id);
      continue;
    }
    const base = (r.parsing_notes || "").trim();
    const update: Record<string, unknown> = {
      parsing_status: "Needs Review",
      parsing_notes: !base ? blocker.note : base.includes(blocker.note) ? base : `${base}; ${blocker.note}`,
      updated_at: now,
    };
    const { update: held } = applyLiveHold(r, update, "Bulk Approve found a problem", live);
    plan.holds.push({ id: r.id, update: held });
  }
  return plan;
}
