// lib/module2-not-taken.ts
//
// "Incomplete · Module 2 not taken" (ticket 969e0414): a Module 2 that was
// closed without the student ever opening it. The cron finalizer grades
// such a row as 0 and stamps metadata.auto_closed_unopened
// (lib/grade-submission autoClosedUnopened); so does an admin force-submit
// of an unopened Module 2. That 0 is not a result: the attempt shows as
// Incomplete with Module 1's result only, and is left out of every SAT
// score, average, analytics and printout headline.
//
// ONE predicate for every view. Pure (no DB), safe in client components.

import { isModule2Track } from "@/lib/student-exam";

/**
 * Select-list entry that brings the flag along without pulling the whole
 * metadata blob: add it to a submissions select and pass the row here.
 */
export const M2_NOT_TAKEN_COLUMN = "m2_not_taken:metadata->auto_closed_unopened";

export interface Module2NotTakenRow {
  adaptive_track?: string | null;
  status?: string | null;
  /** Full metadata, when the caller selected it. */
  metadata?: unknown;
  /** The M2_NOT_TAKEN_COLUMN alias, when the caller selected that instead. */
  m2_not_taken?: unknown;
}

/** Is this row a graded Module 2 that was closed without ever being opened? */
export function isModule2NotTaken(row: Module2NotTakenRow | null | undefined): boolean {
  if (!row || !isModule2Track(row.adaptive_track)) return false;
  if (row.status !== "Submitted" && row.status !== "Late") return false;
  if (row.m2_not_taken === true) return true;
  const meta = row.metadata;
  return Boolean(meta && typeof meta === "object" && (meta as Record<string, unknown>).auto_closed_unopened === true);
}

/** Does any row of this attempt have its Module 2 not taken? */
export function attemptHasModule2NotTaken(rows: readonly Module2NotTakenRow[]): boolean {
  return rows.some(isModule2NotTaken);
}

/**
 * PostgREST `.or()` filter that leaves Module-2-not-taken rows out of a
 * submissions query (analytics over answer_records): `.or(NOT_M2_NOT_TAKEN_OR)`.
 * Same filter the question analytics route already used.
 */
export const NOT_M2_NOT_TAKEN_OR =
  "metadata->auto_closed_unopened.is.null,metadata->auto_closed_unopened.neq.true";
