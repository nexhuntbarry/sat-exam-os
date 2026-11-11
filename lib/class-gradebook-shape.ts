// lib/class-gradebook-shape.ts
//
// Pure scoring of the class gradebook: submission rows → one cell per
// student × assigned test, column averages and each student's summary.
// Every number comes from the shared score code, so a score shows exactly
// what that test's Results page shows for the same attempt:
//   - section test: attempts = sessions, as the Results page groups them,
//     each scored with attemptScore over its rows (the same call);
//   - full-length SAT: attempts by attempt number, fullLengthAttemptScore,
//     then scopedFlScore for a single-subject teacher (total + their own
//     section only).
// Which attempt: the latest one when finished; when the latest isn't
// finished but an earlier one is, the latest FINISHED attempt with a
// "retake in progress" note. Column averages, submitted counts, latest
// Math / R&W and change all use that attempt; the class page's
// "x/y submitted · Avg SAT" is read from these columns, so they agree.

import { attemptScore, averageSat } from "@/lib/score-display";
import {
  flFinished,
  fullLengthAttemptScore,
  groupFullLengthAttempts,
  lastSubmittedAt,
  scopedFlScore,
  type FlAttemptMeta,
  type FlScoreRow,
  type FlSectionScope,
} from "@/lib/full-length-score";
import type { FullLengthChildren, FullLengthLinks } from "@/lib/full-length";
import type {
  CellState,
  Gradebook,
  GradebookCell,
  GradebookColumn,
  GradebookKind,
  GradebookRow,
  ScorePoint,
  StudentSummary,
} from "@/lib/class-gradebook-view";

/** A submission row (module) the gradebook reads. */
export type GradebookSubRow = FlScoreRow & {
  id: string;
  test_id: string;
  student_id: string;
  status: string;
  submitted_at: string | null;
};

export interface GradebookTestInput {
  id: string;
  name: string;
  /** Section of a section test ("Math" / "Reading & Writing"); ignored for a full-length parent. */
  section: string | null;
  dueDate: string | null;
  openDate: string | null;
  createdAt: string | null;
}

export interface ShapeGradebookInput {
  students: { id: string; name: string; email: string }[];
  /** The class's assigned tests the viewer may see (full-length parents, never their children). */
  tests: GradebookTestInput[];
  /** The students' rows on those tests (and on full-length children). */
  rows: GradebookSubRow[];
  links: Pick<FullLengthLinks, "parentOf" | "childrenOf">;
  flMeta: Map<string, FlAttemptMeta>;
  scope: FlSectionScope;
  now: Date;
  /** The test's results page (column header link). */
  testHref: (testId: string) => string;
}

const isGraded = (s: string) => s === "Submitted" || s === "Late";
const moduleRank = (t: string | null | undefined) => (t === "module_1" ? 0 : 1);

export function kindOf(section: string | null, fullLength: boolean): GradebookKind {
  if (fullLength) return "fl";
  if (section === "Math") return "math";
  if (section === "Reading & Writing") return "rw";
  return "other";
}

/**
 * A student's attempts on a section test, newest first. One attempt = the
 * rows of one session (a legacy row without a session is its own
 * attempt), as the Results page groups them; the newest is the one with
 * the most recently started row (studentTestProgress's "latest attempt").
 */
export function sectionAttempts<T extends GradebookSubRow>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.session_id ?? `solo:${r.id}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const startedOf = (g: T[]) => g.map((r) => r.started_at ?? "").sort().pop() ?? "";
  return Array.from(groups.values()).sort((a, b) => startedOf(b).localeCompare(startedOf(a)));
}

/** The latest attempt's rows (studentTestProgress's rule). */
export function latestAttemptRows<T extends GradebookSubRow>(rows: T[]): T[] {
  return sectionAttempts(rows)[0] ?? [];
}

function openState(started: boolean, pastDue: boolean): CellState {
  if (started) return pastDue ? "late" : "in-progress";
  return pastDue ? "missing" : "not-started";
}

const emptyCell = (state: CellState): GradebookCell => ({
  state,
  statusLabel: null,
  sat: null,
  detail: null,
  late: false,
  notes: [],
  pct: null,
  href: null,
  takenAt: null,
  attemptNumber: null,
  rw: null,
  math: null,
  retake: null,
});

/**
 * One student's cell on a section test. Their latest attempt when it is
 * finished; when it isn't but an earlier one is, the latest FINISHED
 * attempt with a "retake in progress" note (never Late / Missing once a
 * score exists); otherwise where the latest attempt stands.
 */
export function sectionCell(testId: string, section: string | null, rows: GradebookSubRow[], pastDue: boolean): GradebookCell {
  const attempts = sectionAttempts(rows).map((g) => {
    // Module 1 first: the Results page links the last (Module 2) row.
    const sorted = [...g].sort((a, b) => moduleRank(a.adaptive_track) - moduleRank(b.adaptive_track));
    return { rows: sorted, score: attemptScore(sorted, section) };
  });
  if (attempts.length === 0) return emptyCell(openState(false, pastDue));
  const latest = attempts[0];
  const shown = attempts.find((a) => a.score.status === "Submitted" || a.score.status === "Late");
  if (shown) {
    const a = shown.score;
    return {
      ...emptyCell("scored"),
      sat: a.score?.sat ?? null,
      detail: a.score?.modules ?? null,
      late: a.status === "Late",
      notes: a.score?.notes ?? [],
      pct: a.score?.pct ?? null,
      href: `/teacher/tests/${testId}/results/${shown.rows[shown.rows.length - 1].id}`,
      takenAt: lastSubmittedAt(shown.rows),
      attemptNumber: shown.rows[0].attempt_number ?? 1,
      retake: shown === latest ? null : { state: "in-progress", attemptNumber: latest.rows[0].attempt_number ?? null },
    };
  }
  const a = latest.score;
  const cell = emptyCell(openState(a.status === "In progress", pastDue));
  // An unfinished attempt keeps its module counts ("M1 20/27 · M2 —").
  return a.status === "In progress" ? { ...cell, detail: a.score?.modules ?? null, attemptNumber: latest.rows[0].attempt_number ?? 1 } : cell;
}

/** Last graded row of a section (the row its "View results" link opens). */
function lastGradedRowId(rows: GradebookSubRow[]): string | null {
  const graded = [...rows].filter((r) => isGraded(r.status)).sort((a, b) => moduleRank(a.adaptive_track) - moduleRank(b.adaptive_track));
  return graded[graded.length - 1]?.id ?? null;
}

export type FlGroup = { rw: GradebookSubRow[]; math: GradebookSubRow[]; attemptNumber: number; key: string };

const isClosed = (status: string) => status === "Closed" || status === "Closed — Math not taken";

/**
 * One student's cell on a full-length SAT, from all their attempts on it:
 * the latest attempt (highest attempt number) when finished, else the
 * latest finished one with a retake note (in progress, or closed), else
 * where the latest attempt stands.
 */
export function fullLengthCell(
  children: FullLengthChildren,
  groups: FlGroup[],
  meta: Map<string, FlAttemptMeta>,
  scope: FlSectionScope,
  pastDue: boolean,
): GradebookCell {
  const scored = [...groups]
    .sort((a, b) => b.attemptNumber - a.attemptNumber)
    .map((g) => ({ g, s: scopedFlScore(fullLengthAttemptScore(g.rw, g.math, meta.get(g.key) ?? null), scope) }));
  if (scored.length === 0) return emptyCell(openState(false, pastDue));
  const latest = scored[0];
  const shown = scored.find((x) => flFinished(x.s));
  if (shown) {
    const { g, s } = shown;
    // Open the first section this viewer may see.
    const [childId, rows] = scope.rw ? [children.rw, g.rw] : [children.math, g.math];
    const rowId = childId ? lastGradedRowId(rows) : null;
    return {
      ...emptyCell("scored"),
      sat: s.total,
      detail: s.score?.modules ?? null,
      late: s.status === "Late",
      notes: s.score?.notes ?? [],
      pct: s.score?.pct ?? null,
      href: rowId ? `/teacher/tests/${childId}/results/${rowId}` : null,
      takenAt: lastSubmittedAt([...g.rw, ...g.math]),
      attemptNumber: g.attemptNumber,
      rw: s.rw.score?.sat ?? null,
      math: s.math.score?.sat ?? null,
      retake:
        shown === latest ? null : { state: isClosed(latest.s.status) ? "closed" : "in-progress", attemptNumber: latest.g.attemptNumber },
    };
  }
  const s = latest.s;
  if (isClosed(s.status)) {
    return { ...emptyCell("closed"), statusLabel: s.status, detail: s.score?.modules ?? null, attemptNumber: latest.g.attemptNumber };
  }
  const started = s.status === "In progress" || s.status === "On break";
  const cell = emptyCell(openState(started, pastDue));
  return started ? { ...cell, detail: s.score?.modules ?? null, attemptNumber: latest.g.attemptNumber } : cell;
}

/** Newest point first (by when it was taken, then by the column's date). */
function byNewest(a: ScorePoint & { order: string }, b: ScorePoint & { order: string }) {
  return (b.takenAt ?? b.order).localeCompare(a.takenAt ?? a.order);
}

/**
 * A student's summary over every column: latest Math / R&W (section tests
 * and the sections of a finished full-length SAT), est. total = the two
 * added, and the change of their most recent finished test vs their
 * previous one of the same subject. Each cell counts with its shown
 * (latest finished) attempt.
 */
export function summarizeStudent(columns: GradebookColumn[], cells: Record<string, GradebookCell>): StudentSummary {
  type P = ScorePoint & { order: string; kind: GradebookKind };
  const tests: P[] = [];
  const math: P[] = [];
  const rw: P[] = [];
  for (const c of columns) {
    const cell = cells[c.id];
    if (!cell || cell.state !== "scored") continue;
    const base = { testId: c.id, testName: c.name, takenAt: cell.takenAt, order: c.date ?? "", kind: c.kind };
    if (cell.sat != null) tests.push({ ...base, score: cell.sat });
    if (c.kind === "math" && cell.sat != null) math.push({ ...base, score: cell.sat });
    if (c.kind === "rw" && cell.sat != null) rw.push({ ...base, score: cell.sat });
    if (c.kind === "fl" && cell.math != null) math.push({ ...base, score: cell.math });
    if (c.kind === "fl" && cell.rw != null) rw.push({ ...base, score: cell.rw });
  }
  const strip = (p: P | undefined): ScorePoint | null =>
    p ? { score: p.score, testId: p.testId, testName: p.testName, takenAt: p.takenAt } : null;
  const latestMath = strip(math.sort(byNewest)[0]);
  const latestRw = strip(rw.sort(byNewest)[0]);
  tests.sort(byNewest);
  const latest = tests[0];
  const previous = latest ? tests.slice(1).find((p) => p.kind === latest.kind) : undefined;
  return {
    latestMath,
    latestRw,
    estTotal: latestMath && latestRw ? latestMath.score + latestRw.score : null,
    change:
      latest && previous
        ? { delta: latest.score - previous.score, kind: latest.kind, latest: strip(latest)!, previous: strip(previous)! }
        : null,
  };
}

/** The whole grid. Columns newest first, students by name. */
export function shapeGradebook(input: ShapeGradebookInput): Gradebook {
  const { links, scope, now } = input;
  const studentIds = new Set(input.students.map((s) => s.id));
  const rows = input.rows.filter((r) => studentIds.has(r.student_id));

  // Section rows: test → student → rows. Full-length rows: attempts per parent + student.
  const { attempts, rest } = groupFullLengthAttempts(rows, links);
  const sectionRows = new Map<string, GradebookSubRow[]>();
  for (const r of rest) {
    const k = `${r.test_id}:${r.student_id}`;
    sectionRows.set(k, [...(sectionRows.get(k) ?? []), r]);
  }
  const flGroups = new Map<string, FlGroup[]>();
  for (const g of attempts) {
    const k = `${g.parentId}:${g.studentId}`;
    flGroups.set(k, [...(flGroups.get(k) ?? []), g]);
  }

  const dated = input.tests.map((t) => ({ t, date: t.dueDate ?? t.openDate ?? t.createdAt ?? null }));
  dated.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.t.name.localeCompare(b.t.name));

  const cellsByStudent = new Map<string, Record<string, GradebookCell>>(input.students.map((s) => [s.id, {}]));
  const columns: GradebookColumn[] = dated.map(({ t, date }) => {
    const children = links.childrenOf.get(t.id) ?? null;
    const kind = kindOf(t.section, Boolean(children));
    const pastDue = Boolean(t.dueDate && new Date(t.dueDate).getTime() < now.getTime());
    const cells: GradebookCell[] = [];
    for (const s of input.students) {
      const cell = children
        ? fullLengthCell(children, flGroups.get(`${t.id}:${s.id}`) ?? [], input.flMeta, scope, pastDue)
        : sectionCell(t.id, t.section, sectionRows.get(`${t.id}:${s.id}`) ?? [], pastDue);
      cellsByStudent.get(s.id)![t.id] = cell;
      cells.push(cell);
    }
    const done = cells.filter((c) => c.state === "scored");
    const pcts = done.map((c) => c.pct).filter((p): p is number => p != null);
    return {
      id: t.id,
      name: t.name,
      kind,
      date,
      dueDate: t.dueDate,
      href: input.testHref(t.id),
      avg: averageSat(done.map((c) => c.sat)),
      avgRw: kind === "fl" && scope.rw ? averageSat(done.map((c) => c.rw)) : null,
      avgMath: kind === "fl" && scope.math ? averageSat(done.map((c) => c.math)) : null,
      avgPct: pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
      scored: done.filter((c) => c.sat != null).length,
      submitted: done.length,
      inProgress: cells.filter((c) => c.state === "in-progress" || c.state === "late" || c.retake?.state === "in-progress").length,
    };
  });

  const out: GradebookRow[] = input.students
    .map((s) => {
      const cells = cellsByStudent.get(s.id)!;
      return { studentId: s.id, name: s.name, email: s.email, cells, summary: summarizeStudent(columns, cells) };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.studentId.localeCompare(b.studentId));

  return {
    columns,
    rows: out,
    scope: { rw: scope.rw, math: scope.math },
    averages: {
      latestMath: averageSat(out.map((r) => r.summary.latestMath?.score)),
      latestRw: averageSat(out.map((r) => r.summary.latestRw?.score)),
      estTotal: averageSat(out.map((r) => r.summary.estTotal)),
    },
  };
}
