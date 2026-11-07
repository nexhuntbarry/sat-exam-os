// lib/question-save-guard.ts
//
// Guards for a reviewer's save (PATCH /api/admin/questions/[id]), pure so
// they can be tested:
//   - staleSave: the page loaded the question before a newer key /
//     explanation was saved (another save, a key change that rewrote or hid
//     the explanation) — writing its copy back would restore the old text.
//   - editedExplanationProblem: a changed, non-empty explanation must pass
//     every check for the key it is saved with.

import { draftRejection, type AutoFixRow } from "@/lib/explanation-autofix";

export interface SaveBase {
  correct_answer?: string | null;
  explanation?: string | null;
}

/** True when the save was made on top of an older key / explanation / row. */
export function staleSave(
  prior: Pick<AutoFixRow, "correct_answer" | "explanation" | "updated_at">,
  body: { expected_updated_at?: unknown; base?: unknown },
): boolean {
  if (typeof body.expected_updated_at === "string" && prior.updated_at && body.expected_updated_at !== prior.updated_at) return true;
  const base = body.base && typeof body.base === "object" ? (body.base as SaveBase) : null;
  if (!base) return false;
  if ("correct_answer" in base && (base.correct_answer ?? null) !== (prior.correct_answer ?? null)) return true;
  if ("explanation" in base && (base.explanation ?? null) !== (prior.explanation ?? null)) return true;
  return false;
}

/** Why the edited explanation can't be saved with `next` (null = fine, unchanged or empty). */
export function editedExplanationProblem(prior: AutoFixRow, next: AutoFixRow, body: { explanation?: unknown }): string | null {
  if (!("explanation" in body)) return null;
  const text = String(body.explanation ?? "").trim();
  if (!text || text === (prior.explanation ?? "").trim()) return null;
  if (!(next.correct_answer ?? "").trim()) return null;
  return draftRejection(next, text);
}
