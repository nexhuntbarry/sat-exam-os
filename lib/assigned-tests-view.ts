// lib/assigned-tests-view.ts
//
// "Assigned Tests" on the teacher's class page and "Today's tests" on the
// teacher dashboard: the pure shaping behind both lists. Pure and
// client-safe (type imports + the gradebook view's pure helpers only).
//
// The class list is read off the class Scores gradebook (lib/class-gradebook,
// already limited to the class's assignments, the viewer's QA side and the
// teacher's subject), so the row counts and the grid always agree. The
// caller intersects it with getTeacherTestScope (lib/teacher-access) so a
// test outside the teacher's reach is never listed.

import type { ScoreDisplay } from "./score-display";
import { nyDay, type CellState, type Gradebook, type GradebookCell, type GradebookColumn, type GradebookKind } from "./class-gradebook-view";

/** Where a student stands on one assigned test (one bucket per student). */
export type StudentTestState = "submitted" | "in-progress" | "not-started";

export interface CompletionCounts {
  submitted: number;
  inProgress: number;
  notStarted: number;
  total: number;
}

export interface AssignedTestStudent {
  studentId: string;
  name: string;
  email: string;
  state: StudentTestState;
  /**
   * Finished: the score the viewer may see (a single-subject teacher: their
   * full-length section), for ScoreCell. null otherwise.
   */
  score: ScoreDisplay | null;
  /** "Late", "Missing", "Closed — Math not taken", "Retake in progress"… */
  note: string | null;
  /** Gets a live line (in progress, or a retake in progress). */
  live: boolean;
  /** That student's result page, when finished and visible. */
  href: string | null;
}

export interface AssignedTestRow {
  id: string;
  name: string;
  kind: GradebookKind;
  status: string | null;
  openDate: string | null;
  dueDate: string | null;
  /** Opens or is due today (New York day). */
  today: boolean;
  counts: CompletionCounts;
  /** Class average the viewer may see (single-subject teacher on a full-length SAT: their section). */
  avgSat: number | null;
  avgPct: number | null;
  /** "Math" / "R&W" when avgSat is one full-length section, else null. */
  avgSection: string | null;
  students: AssignedTestStudent[];
}

/** Teacher's Class Review (projector) page: "Questions & answers". */
export function classReviewHref(testId: string): string {
  return `/teacher/tests/${testId}/review`;
}

export function teacherResultsHref(testId: string): string {
  return `/teacher/tests/${testId}/results`;
}

const BUCKET: Record<CellState, StudentTestState> = {
  scored: "submitted",
  // A full-length attempt closed before it was finished is over (the
  // Submissions page's summary counts "Closed …" as submitted too).
  closed: "submitted",
  "in-progress": "in-progress",
  late: "in-progress",
  "not-started": "not-started",
  missing: "not-started",
};

const SECTION_WORDS: Record<"math" | "rw", string[]> = { math: ["Math"], rw: ["R&W", "Reading & Writing", "Reading and Writing"] };

/**
 * A full-length attempt closed with the viewer's own section never taken
 * ("Closed — Math not taken" for a Math-only teacher): for them the student
 * hasn't taken the test.
 */
function closedOwnSectionNotTaken(cell: Pick<GradebookCell, "state" | "statusLabel">, kind: GradebookKind, scope: Gradebook["scope"]): boolean {
  if (cell.state !== "closed") return false;
  const sec = flSection(kind, scope);
  const missed = cell.statusLabel?.match(/^Closed — (.+) not taken$/)?.[1];
  return !!sec && !!missed && SECTION_WORDS[sec].includes(missed);
}

/**
 * One bucket per student, so the three counts add up to the class size.
 * Pass the column kind and viewer scope so a closed full-length attempt
 * without the viewer's section counts as not started.
 */
export function cellBucket(
  cell: Pick<GradebookCell, "state" | "statusLabel">,
  kind: GradebookKind = "other",
  scope: Gradebook["scope"] = { rw: true, math: true },
): StudentTestState {
  if (closedOwnSectionNotTaken(cell, kind, scope)) return "not-started";
  return BUCKET[cell.state];
}

/** Single-subject viewer on a full-length SAT sees their section only. */
function flSection(kind: GradebookKind, scope: Gradebook["scope"]): "math" | "rw" | null {
  if (kind !== "fl" || (scope.rw && scope.math)) return null;
  return scope.math ? "math" : scope.rw ? "rw" : null;
}

/** The score a viewer may see in a cell: the total, or their section of a full-length SAT. */
export function visibleSat(cell: Pick<GradebookCell, "sat" | "rw" | "math">, kind: GradebookKind, scope: Gradebook["scope"]): number | null {
  const sec = flSection(kind, scope);
  if (sec === "math") return cell.math;
  if (sec === "rw") return cell.rw;
  return kind === "fl" && !(scope.rw && scope.math) ? null : cell.sat;
}

/** The class average a viewer may see for a column (see visibleSat). */
export function visibleAvg(col: Pick<GradebookColumn, "kind" | "avg" | "avgRw" | "avgMath">, scope: Gradebook["scope"]): { avg: number | null; section: string | null } {
  const sec = flSection(col.kind, scope);
  if (sec === "math") return { avg: col.avgMath, section: "Math" };
  if (sec === "rw") return { avg: col.avgRw, section: "R&W" };
  if (col.kind === "fl" && !(scope.rw && scope.math)) return { avg: null, section: null };
  return { avg: col.avg, section: null };
}

/** Opens or is due on `today` (yyyy-mm-dd, New York). */
export function isTodayTest(t: { openDate: string | null; dueDate: string | null }, today: string): boolean {
  return (t.openDate != null && nyDay(t.openDate) === today) || (t.dueDate != null && nyDay(t.dueDate) === today);
}

/** "3 / 4 submitted · 1 in progress · 0 not started". */
export function completionText(c: CompletionCounts): string {
  return `${c.submitted} / ${c.total} submitted · ${c.inProgress} in progress · ${c.notStarted} not started`;
}

const NOTE: Partial<Record<CellState, string>> = { late: "Late", missing: "Missing" };
const ORDER: Record<StudentTestState, number> = { "in-progress": 0, "not-started": 1, submitted: 2 };

/**
 * Rows for the class's Assigned Tests: one per gradebook column the viewer
 * reaches (`reach`, from reachableTestIds; null = no extra filter), today's
 * tests first, then the gradebook's order (newest first). Students: in
 * progress, then not started, then submitted; by name within each.
 */
export function assignedTestRows(
  gradebook: Pick<Gradebook, "columns" | "rows" | "scope">,
  reach: Set<string> | null,
  now: Date,
): AssignedTestRow[] {
  const today = nyDay(now.toISOString());
  const rows = gradebook.columns
    .filter((c) => !reach || reach.has(c.id))
    .map((c): AssignedTestRow => {
      const openDate = c.openDate ?? null;
      const dueDate = c.dueDate;
      const counts: CompletionCounts = { submitted: 0, inProgress: 0, notStarted: 0, total: 0 };
      const students: AssignedTestStudent[] = [];
      for (const r of gradebook.rows) {
        const cell = r.cells[c.id];
        if (!cell) continue;
        const state = cellBucket(cell, c.kind, gradebook.scope);
        counts.total++;
        if (state === "submitted") counts.submitted++;
        else if (state === "in-progress") counts.inProgress++;
        else counts.notStarted++;
        const retake = cell.retake ? (cell.retake.state === "closed" ? "Retake closed" : "Retake in progress") : null;
        students.push({
          studentId: r.studentId,
          name: r.name,
          email: r.email,
          state,
          score:
            state === "submitted"
              ? { sat: visibleSat(cell, c.kind, gradebook.scope), modules: cell.detail ?? "", pct: cell.pct, notes: cell.notes }
              : null,
          note: cell.state === "closed" ? (state === "not-started" ? "Closed" : cell.statusLabel ?? "Closed") : retake ?? (cell.late ? "Late" : NOTE[cell.state] ?? null),
          live: cell.state === "in-progress" || cell.state === "late" || cell.retake?.state === "in-progress",
          href: cell.href,
        });
      }
      students.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name) || a.studentId.localeCompare(b.studentId));
      const avg = visibleAvg(c, gradebook.scope);
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        status: c.status ?? null,
        openDate,
        dueDate,
        today: isTodayTest({ openDate, dueDate }, today),
        counts,
        avgSat: avg.avg,
        avgPct: avg.section ? null : c.avgPct,
        avgSection: avg.section,
        students,
      };
    });
  // Stable: today's tests first, otherwise the gradebook's newest-first order.
  return rows.map((r, i) => ({ r, i })).sort((a, b) => Number(b.r.today) - Number(a.r.today) || a.i - b.i).map((x) => x.r);
}

/**
 * Dashboard "Today's tests": tests in the teacher's reach (getTeacherTestScope
 * testIds) that are assigned to one of their classes or students (or to
 * them directly on teacher_ids) and open or are due today: Published, or
 * Closed when due today (never Draft / Archived). Sorted by the
 * day's time (open, else due), then name.
 */
export function todaysTests<T extends { id: string; name: string; status: string | null; openDate: string | null; dueDate: string | null }>(
  tests: T[],
  assignments: { test_id: string; teacher_ids?: unknown; class_group_ids?: unknown; student_ids?: unknown }[],
  scope: { userId: string; testIds: Set<string>; myGroupIds: Set<string>; myStudentIds: Set<string>; isAdmin: boolean },
  now: Date,
): T[] {
  const ids = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
  const assigned = new Set<string>();
  for (const a of assignments) {
    if (
      scope.isAdmin ||
      ids(a.teacher_ids).includes(scope.userId) ||
      ids(a.class_group_ids).some((g) => scope.myGroupIds.has(g)) ||
      ids(a.student_ids).some((s) => scope.myStudentIds.has(s))
    ) {
      assigned.add(a.test_id);
    }
  }
  const today = nyDay(now.toISOString());
  const at = (t: T) => (t.openDate && nyDay(t.openDate) === today ? t.openDate : t.dueDate) ?? "";
  return tests
    .filter(
      (t) =>
        scope.testIds.has(t.id) &&
        assigned.has(t.id) &&
        isTodayTest(t, today) &&
        (t.status === "Published" || (t.status === "Closed" && t.dueDate != null && nyDay(t.dueDate) === today)),
    )
    .sort((a, b) => at(a).localeCompare(at(b)) || a.name.localeCompare(b.name));
}

/**
 * SQL pre-filter for today's tests: a window wide enough to hold every
 * instant of today's New York day (±36 h of now covers any UTC offset and
 * DST change); the exact day is then checked with isTodayTest.
 */
export function todayWindow(now: Date): { from: string; to: string } {
  const h = 36 * 3600_000;
  return { from: new Date(now.getTime() - h).toISOString(), to: new Date(now.getTime() + h).toISOString() };
}

/**
 * Dashboard "x / y submitted": distinct students with a finished attempt
 * per test, counting only students on that test's roster (`roster`, the
 * assigned students the viewer sees). A retake doesn't count twice.
 */
export function submittedStudentsByTest(
  attempts: { testId: string; studentId: string; done: boolean }[],
  roster: Map<string, Set<string>>,
): Record<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const a of attempts) {
    if (!a.done || !roster.get(a.testId)?.has(a.studentId)) continue;
    let s = seen.get(a.testId);
    if (!s) seen.set(a.testId, (s = new Set()));
    s.add(a.studentId);
  }
  return Object.fromEntries(Array.from(seen, ([id, s]) => [id, s.size]));
}
