// lib/reparse-key-restore.ts
//
// Re-parse in place (app/api/cron/reparse-inplace): last safety net before
// rescoring and auto-promote. explain-official and the truncation guard get
// the stored keys and never write correct_answer for these rows, so this only
// catches what the run itself may still have left.
//
// - It only puts the stored key back when the current correct_answer is the
//   solver's answer AND the row hasn't been written since the run put the
//   stored key back after the solver (solverWrittenAt). Anything else is taken
//   as a person's edit during the run: left as is, with a note, and a row
//   that isn't Approved goes to Needs Review (so auto-promote can't take it).
// - Writes are compare-and-set on (id, updated_at, correct_answer); a row that
//   changed since the read is left as is, with a note.
// - A restored row goes to Needs Review (never left Draft or Approved on a
//   key that was narrowed); a row that is live and Approved now only gets the
//   live-fix tag (applyLiveHold: never demoted, answer not changed).
// - If the pass can't finish (a read or write error), the affected rows are
//   marked "not rescored", sent to Needs Review where that can't demote a
//   live question, and the caller must skip auto-promote for the module.

import { applyLiveHold, type LiveHoldRow } from "@/lib/live-questions";
import { restoredExplanationNote, restoredKeyNote, storedKeyAfterSolve } from "@/lib/answer-key-merge";

export interface RestoreEntry {
  id: string;
  /** The stored key the row must end the run with. */
  stored: string;
  /** The solver's answer in this run (null = none / not captured). */
  solver: string | null;
  /** updated_at of the run's own write putting the stored key back after the solver (null = unknown). */
  solverWrittenAt: string | null;
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
// The run's put-back after the solver (putBackStoredKeys) already wrote the
// stored key and every later run pass leaves correct_answer alone for these
// rows, so a row still on the solver's answer AND not written since that
// put-back is practically impossible — the write-back below rarely runs.
// Anything newer is someone else's write. Do not loosen this (e.g. by dropping
// the timestamp or accepting other "known" values): it is what keeps a
// person's edit made during the run from being overwritten.
const notLater = (a: string | null, b: string | null) => !!a && !!b && Date.parse(a) <= Date.parse(b);
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
      const ours = e.solver !== null && current === e.solver && notLater(row.updated_at, e.solverWrittenAt);
      let update: Record<string, unknown>;
      let kind: "restore" | "person";
      if (!ours) {
        kind = "person";
        update = {
          parsing_notes: appendNote(row.parsing_notes, personEditNote(current, e.stored)),
          ...(row.parsing_status !== "Approved" ? { parsing_status: "Needs Review" } : {}),
        };
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
        // Changed since the read: whoever changed it wins; say so (compare-and-set
        // again — if that misses too, the row counts as not finished).
        const { data: again, error: rErr } = await deps.db
          .from("questions")
          .select("parsing_notes, parsing_status, updated_at")
          .eq("id", row.id)
          .maybeSingle();
        if (rErr || !again) {
          out.failed.push(row.id);
          continue;
        }
        let nq = deps.db
          .from("questions")
          .update({
            parsing_notes: appendNote(again.parsing_notes ?? null, personEditNote("another value", e.stored)),
            ...(again.parsing_status !== "Approved" ? { parsing_status: "Needs Review" } : {}),
            updated_at: now(),
          })
          .eq("id", row.id);
        nq = again.updated_at === null ? nq.is("updated_at", null) : nq.eq("updated_at", again.updated_at);
        const { data: noted, error: nErr } = await nq.select("id");
        if (nErr || !noted || noted.length === 0) out.failed.push(row.id);
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
    await failClosed(out.failed, RESTORE_FAILED_WHY, deps);
  }
  return out;
}

/**
 * Rows whose stored key couldn't be confirmed: "not rescored" note (a
 * "Needs review:" note, so explain-official / auto-fix keep them in review)
 * and Needs Review — never for a question that may be live. The caller must
 * skip auto-promote. Throws if the Needs Review write fails.
 */
export async function failClosed(
  ids: string[],
  why: string,
  deps: Pick<RestoreDeps, "db" | "liveIds" | "markNotRescored" | "now">,
): Promise<void> {
  if (ids.length === 0) return;
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    await deps.markNotRescored(ids, why);
  } catch {
    /* the module is still not promoted */
  }
  let live: Set<string> | null = null;
  try {
    live = await deps.liveIds(ids);
  } catch {
    live = null;
  }
  const safe = live ? ids.filter((id) => !live!.has(id)) : ids;
  if (safe.length === 0) return;
  let q = deps.db.from("questions").update({ parsing_status: "Needs Review", updated_at: now() }).in("id", safe);
  if (!live) q = q.neq("parsing_status", "Approved");
  const { error } = await q;
  if (error) throw new Error(`reparse key restore: couldn't send ${safe.length} row(s) to Needs Review: ${error.message}`);
}

export const PUTBACK_FAILED_WHY = "the re-parse couldn't put the stored key back after the solver";

/**
 * Right after the solver: put each row's stored key back (compare-and-set
 * over exactly what the solver left), flag a disagreeing solver answer, and
 * record the write's updated_at for the final restore's "ours" check. A read
 * error, write error or missed compare-and-set lands in `failed` — the caller
 * must failClosed() those rows and skip auto-promote.
 */
export async function putBackStoredKeys(
  entries: { id: string; stored: string; review: string[] }[],
  deps: { db: Db; now?: () => string },
): Promise<{ solverById: Map<string, string | null>; writtenAt: Map<string, string>; reviewed: Set<string>; failed: string[] }> {
  const now = deps.now ?? (() => new Date().toISOString());
  const out = { solverById: new Map<string, string | null>(), writtenAt: new Map<string, string>(), reviewed: new Set<string>(), failed: [] as string[] };
  for (const e of entries) {
    const { data: row, error: readErr } = await deps.db
      .from("questions")
      .select("correct_answer, parsing_notes, parsing_status, updated_at")
      .eq("id", e.id)
      .maybeSingle();
    if (readErr || !row) {
      out.failed.push(e.id);
      continue;
    }
    const solver = (row.correct_answer as string | null) ?? null;
    out.solverById.set(e.id, solver);
    const after = storedKeyAfterSolve(e.stored, solver);
    const review = [...e.review, ...(after.review ? [after.review] : [])];
    const update: Record<string, unknown> = { correct_answer: after.correct, updated_at: now() };
    if (review.length) {
      update.parsing_status = "Needs Review";
      update.parsing_notes = review.reduce((n, r) => appendNote(n, r), (row.parsing_notes as string | null) ?? "");
    }
    // The solver's explanation argues its own answer, not the stored key.
    if (after.review) update.explanation = null;
    let w = deps.db.from("questions").update(update).eq("id", e.id);
    w = row.updated_at == null ? w.is("updated_at", null) : w.eq("updated_at", row.updated_at);
    w = solver == null ? w.is("correct_answer", null) : w.eq("correct_answer", solver);
    const { data: wrote, error: wErr } = await w.select("updated_at");
    if (wErr || !wrote || wrote.length === 0 || !wrote[0].updated_at) {
      out.failed.push(e.id);
      continue;
    }
    out.writtenAt.set(e.id, wrote[0].updated_at as string);
    if (review.length) out.reviewed.add(e.id);
  }
  return out;
}
