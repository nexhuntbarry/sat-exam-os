// lib/reparse-key-restore.ts
//
// Re-parse in place (app/api/cron/reparse-inplace): last safety net before
// rescoring and auto-promote. The run writes official_answer = the stored key
// (lib/answer-key-merge.ts reparseKeyDecision), so the passes that set
// correct_answer = official_answer derive the stored key themselves; this only
// catches a row where something the run itself wrote still left another key.
//
// - It only puts the stored key back when the current correct_answer is a
//   value the run's own passes could have written (the row's prior
//   official_answer or the solver's answer). Anything else is taken as a
//   person's edit during the run: left as is, with a note.
// - Writes are compare-and-set on (id, updated_at, correct_answer); a row that
//   changed since the read is left as is, with a note.
// - A restored row goes to Needs Review (never left Draft or Approved on a
//   key that was narrowed); a row that is live and Approved now only gets the
//   live-fix tag (applyLiveHold: never demoted, answer not changed).
// - If the pass can't finish (a read or write error), the affected rows are
//   marked "not rescored", sent to Needs Review where that can't demote a
//   live question, and the caller must skip auto-promote for the module.

import { applyLiveHold, type LiveHoldRow } from "@/lib/live-questions";
import { restoredExplanationNote, restoredKeyNote } from "@/lib/answer-key-merge";

export interface RestoreEntry {
  id: string;
  /** The stored key the row must end the run with. */
  stored: string;
  /** official_answer before this run. */
  priorOfficial: string | null;
  /** The solver's answer in this run (null = none / not captured). */
  solver: string | null;
}

interface RestoreRow {
  id: string;
  correct_answer: string | null;
  explanation: string | null;
  parsing_status: string | null;
  parsing_notes: string | null;
  question_type: string | null;
  question_text: string | null;
  updated_at: string | null;
}

/** Minimal slice of the Supabase client this pass uses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any };

export interface RestoreDeps {
  db: Db;
  /** Ids (of those given) that are in a live test now (lib/live-questions liveQuestionIds). */
  liveIds: (ids: string[]) => Promise<Set<string>>;
  /** Why the explanation argues another answer than `key`, else null (lib/explanation-autofix explanationArguesOther). */
  arguesOther: (row: RestoreRow, key: string) => string | null;
  /** lib/reparse-rescore markNotRescored, bound to the db. */
  markNotRescored: (ids: string[], why: string) => Promise<void>;
  now?: () => string;
}

export interface RestoreResult {
  /** Rows whose stored key was written back. */
  restored: number;
  /** Rows left as is because a person changed them (notes added). */
  personEdits: string[];
  /** Live, Approved rows only tagged (answer not changed). */
  liveHeld: string[];
  /** Rows the pass couldn't finish. */
  failed: string[];
  /** true → the caller must not auto-promote this module. */
  skipPromote: boolean;
}

export const personEditNote = (current: string | null, stored: string) =>
  `Needs review: the key was changed to ${current ?? "(none)"} during this re-parse, not by it; it was left as is (the stored key was ${stored}) — confirm which is right`;
export const RESTORE_FAILED_WHY = "the re-parse couldn't confirm the stored key";

const appendNote = (notes: string | null, note: string) => {
  const parts = (notes ?? "").split(";").map((x) => x.trim()).filter(Boolean);
  if (!parts.includes(note)) parts.push(note);
  return parts.join("; ");
};

export async function restoreStoredKeys(entries: RestoreEntry[], deps: RestoreDeps): Promise<RestoreResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const out: RestoreResult = { restored: 0, personEdits: [], liveHeld: [], failed: [], skipPromote: false };
  const byId = new Map(entries.map((e) => [e.id, e]));
  const ids = [...byId.keys()];

  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await deps.db
      .from("questions")
      .select("id, correct_answer, explanation, parsing_status, parsing_notes, question_type, question_text, updated_at")
      .in("id", chunk);
    if (error || !data) {
      out.failed.push(...chunk);
      continue;
    }
    const rows = data as RestoreRow[];
    let live: Set<string>;
    try {
      live = await deps.liveIds(rows.filter((r) => r.parsing_status === "Approved").map((r) => r.id));
    } catch {
      out.failed.push(...rows.map((r) => r.id));
      continue;
    }
    for (const row of rows) {
      const e = byId.get(row.id)!;
      const current = row.correct_answer;
      if (current === e.stored) continue;
      // Compare-and-set: only if nothing touched the row since the read.
      const cas = (update: Record<string, unknown>) => {
        let q = deps.db.from("questions").update({ ...update, updated_at: now() }).eq("id", row.id);
        q = row.updated_at === null ? q.is("updated_at", null) : q.eq("updated_at", row.updated_at);
        q = current === null ? q.is("correct_answer", null) : q.eq("correct_answer", current);
        return q.select("id");
      };
      const ours = [e.priorOfficial, e.solver].some((v) => v !== null && v === current);
      let update: Record<string, unknown>;
      let kind: "restore" | "person";
      if (!ours) {
        kind = "person";
        update = { parsing_notes: appendNote(row.parsing_notes, personEditNote(current, e.stored)) };
      } else {
        kind = "restore";
        const why = deps.arguesOther(row, e.stored);
        update = {
          correct_answer: e.stored,
          parsing_status: "Needs Review",
          parsing_notes: appendNote(row.parsing_notes, why ? restoredExplanationNote(e.stored, why) : restoredKeyNote(e.stored, current ?? "(none)")),
          ...(why ? { explanation: null } : {}),
        };
      }
      const { update: held, held: isHeld } = applyLiveHold(
        row as unknown as LiveHoldRow,
        update,
        "Re-parse found its stored key changed",
        live,
      );
      const { data: written, error: wErr } = await cas(held);
      if (wErr) {
        out.failed.push(row.id);
        continue;
      }
      if (!written || written.length === 0) {
        // Changed since the read: whoever changed it wins; say so.
        const { data: again, error: rErr } = await deps.db.from("questions").select("parsing_notes").eq("id", row.id).maybeSingle();
        if (rErr) {
          out.failed.push(row.id);
          continue;
        }
        const { error: nErr } = await deps.db
          .from("questions")
          .update({ parsing_notes: appendNote(again?.parsing_notes ?? null, personEditNote("another value", e.stored)) })
          .eq("id", row.id);
        if (nErr) out.failed.push(row.id);
        else out.personEdits.push(row.id);
        continue;
      }
      if (isHeld) out.liveHeld.push(row.id);
      else if (kind === "person") out.personEdits.push(row.id);
      else out.restored++;
    }
  }

  if (out.failed.length > 0) {
    out.skipPromote = true;
    try {
      await deps.markNotRescored(out.failed, RESTORE_FAILED_WHY);
    } catch {
      /* the module is still not promoted */
    }
    // Needs Review, but never demote a question that may be live.
    let live: Set<string> | null = null;
    try {
      live = await deps.liveIds(out.failed);
    } catch {
      live = null;
    }
    const safe = live ? out.failed.filter((id) => !live!.has(id)) : out.failed;
    if (safe.length > 0) {
      let q = deps.db.from("questions").update({ parsing_status: "Needs Review", updated_at: now() }).in("id", safe);
      if (!live) q = q.neq("parsing_status", "Approved");
      await q;
    }
  }
  return out;
}
