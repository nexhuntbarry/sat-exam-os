// lib/attempt-actions.ts
//
// What the "…" row menu on the admin test page (Students table) and its
// Submissions page offers for one attempt, and the facts its confirmation
// dialogs quote (ticket 969e0414). Pure: the pages pass the submission
// rows they already loaded; components/AttemptActionsMenu renders it. The
// actions themselves are the existing admin APIs (force-submit, reset,
// DELETE, grant-retake, remove-students) plus reopen-module-2.

import { isModule2Track } from "@/lib/student-exam";
import { isModule2NotTaken, type Module2NotTakenRow } from "@/lib/module2-not-taken";
import { MODULE_2_LATE_RECOVERY_HOURS } from "@/lib/module2-handoff";

/**
 * Submission columns the menu needs (add M2_NOT_TAKEN_COLUMN too). Saved
 * answers are only counted for open modules: load them for the In Progress
 * rows alone with withOpenAnswers().
 */
export const ATTEMPT_ACTION_COLUMNS =
  "id, status, adaptive_track, session_id, started_at, attempt_number, correct_count, total_questions, m2_started:metadata->module_2_started_at";

/**
 * Adds `answers` to the In Progress rows only (one small query), so a page
 * listing every attempt doesn't pull every graded row's answers just to
 * count them. Graded rows keep `answers` undefined (their count isn't used).
 */
export async function withOpenAnswers<T extends { id: string; status: string }>(
  db: { from: (t: string) => any }, // eslint-disable-line @typescript-eslint/no-explicit-any
  rows: T[],
): Promise<(T & { answers?: unknown })[]> {
  const open = rows.filter((r) => r.status === "In Progress").map((r) => r.id);
  if (open.length === 0) return rows;
  const { data, error } = await db.from("submissions").select("id, answers").in("id", open);
  if (error) throw new Error(`open answers lookup failed: ${error.message}`);
  const byId = new Map(((data ?? []) as { id: string; answers: unknown }[]).map((r) => [r.id, r.answers]));
  return rows.map((r) => (byId.has(r.id) ? { ...r, answers: byId.get(r.id) } : r));
}

export interface AttemptActionRow extends Module2NotTakenRow {
  id: string;
  status: string;
  adaptive_track?: string | null;
  session_id?: string | null;
  started_at?: string | null;
  attempt_number?: number | null;
  correct_count?: number | null;
  total_questions?: number | null;
  /** Saved answers (only their count is used). */
  answers?: unknown;
  /** metadata->module_2_started_at (ATTEMPT_ACTION_COLUMNS). */
  m2_started?: unknown;
}

export interface AttemptModuleFacts {
  id: string;
  number: 1 | 2;
  status: "In progress" | "Submitted";
  /** Graded counts (Submitted only, and not "not taken"). */
  correct: number | null;
  total: number | null;
  /** Answers saved on the row. */
  answered: number;
  /** Module 2: the student pressed Start (its clock runs). Module 1: always true. */
  opened: boolean;
  /** Module 2 closed without being opened (lib/module2-not-taken). */
  notTaken: boolean;
  /** "Easy" / "Hard" for an adaptive Module 2, else null. */
  track: string | null;
}

export type AttemptMenuState = "in_progress" | "finished" | "incomplete";

export interface AttemptFacts {
  state: AttemptMenuState;
  /** Two-module attempt (rows carry a track). */
  twoModules: boolean;
  attemptNumber: number;
  modules: AttemptModuleFacts[];
  /** Every row of the attempt (Delete attempt). */
  rowIds: string[];
}

const graded = (s: string) => s === "Submitted" || s === "Late";

function answeredCount(answers: unknown): number {
  return answers && typeof answers === "object" ? Object.keys(answers as Record<string, unknown>).length : 0;
}

/** The latest attempt's rows: the session of the most recently started row (studentTestProgress's rule). */
export function latestAttemptOf<T extends AttemptActionRow>(rows: T[]): T[] {
  if (rows.length === 0) return [];
  const latest = [...rows].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0];
  return latest.session_id ? rows.filter((r) => r.session_id === latest.session_id) : [latest];
}

/** One attempt's rows → what the menu and its dialogs need. Null for no rows. */
export function attemptFacts(rows: AttemptActionRow[]): AttemptFacts | null {
  if (rows.length === 0) return null;
  const twoModules = rows.some((r) => Boolean(r.adaptive_track));
  const modules: AttemptModuleFacts[] = [...rows]
    .sort((a, b) => (isModule2Track(a.adaptive_track) ? 1 : 0) - (isModule2Track(b.adaptive_track) ? 1 : 0))
    .map((r) => {
      const m2 = isModule2Track(r.adaptive_track);
      const notTaken = isModule2NotTaken(r);
      const done = graded(r.status);
      const metaStamp = r.metadata && typeof r.metadata === "object" ? (r.metadata as Record<string, unknown>).module_2_started_at : undefined;
      const stamp = [r.m2_started, metaStamp].find((v): v is string => typeof v === "string" && v.length > 0) ?? null;
      return {
        id: r.id,
        number: m2 ? 2 : 1,
        status: done ? "Submitted" : "In progress",
        correct: done && !notTaken ? r.correct_count ?? 0 : null,
        total: done && !notTaken ? r.total_questions ?? 0 : null,
        answered: answeredCount(r.answers),
        // Answers imply it was opened (older rows have no stamp).
        opened: !m2 || stamp != null || answeredCount(r.answers) > 0,
        notTaken,
        track: r.adaptive_track === "module_2_easy" ? "Easy" : r.adaptive_track === "module_2_hard" ? "Hard" : null,
      };
    });
  const anyOpen = rows.some((r) => r.status === "In Progress");
  const m1 = modules.find((m) => m.number === 1);
  const m2 = modules.find((m) => m.number === 2);
  let state: AttemptMenuState;
  if (anyOpen) state = "in_progress";
  else if (m2?.notTaken) state = "incomplete";
  // Module 1 graded, Module 2 not created yet (handoff pending): still in progress.
  else if (twoModules && m1 && !m2) state = "in_progress";
  else state = "finished";
  return {
    state,
    twoModules,
    attemptNumber: rows[0].attempt_number ?? 1,
    modules,
    rowIds: rows.map((r) => r.id),
  };
}

/** "21/22", "not taken", "12 answers saved" … for a dialog. */
export function moduleSummary(m: AttemptModuleFacts): { kind: "score" | "notTaken" | "notOpened" | "open"; score?: string; answered?: number } {
  if (m.notTaken) return { kind: "notTaken" };
  if (m.status === "Submitted") return { kind: "score", score: `${m.correct ?? 0}/${m.total ?? 0}` };
  if (!m.opened) return { kind: "notOpened" };
  return { kind: "open", answered: m.answered };
}

/**
 * When a reopened (unopened) Module 2 is closed again by the cron
 * (lib/finalize-stale unopenedModule2CloseReason): never without a due
 * date; otherwise once the due date has passed and the past-due window
 * since the reopen (the new handoff) has run out — whichever is later.
 */
export function reopenedModule2ClosesAt(dueDate: string | null, now = Date.now()): Date | null {
  if (!dueDate) return null;
  const due = new Date(dueDate).getTime();
  if (!Number.isFinite(due)) return null;
  return new Date(Math.max(due, now + MODULE_2_LATE_RECOVERY_HOURS * 3_600_000));
}
