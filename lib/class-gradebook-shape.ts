// lib/class-gradebook-shape.ts
//
// Pure scoring of the class gradebook: submission rows → one cell per
// student × assigned test, column averages and each student's summary.
// Every number comes from the shared score code, so a cell shows exactly
// what that test's Results page shows for the same attempt:
//   - section test: the student's latest attempt (the session of their
//     most recently started row, as studentTestProgress / the class page's
//     "x/y submitted · Avg SAT" pick it), scored with attemptScore over
//     that attempt's rows — the same call the Results page makes per row;
//   - full-length SAT: the latest attempt (highest attempt number,
//     latestFlAttemptGroups), fullLengthAttemptScore, then scopedFlScore
//     for a single-subject teacher (total + their own section only).
// Column averages use averageSat over finished cells, like Avg SAT.

import { attemptScore, averageSat } from "@/lib/score-display";
import {
  flFinished,
  fullLengthAttemptScore,
  groupFullLengthAttempts,
  lastSubmittedAt,
  latestFlAttemptGroups,
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

/** The latest attempt's rows: the session of the most recently started row (studentTestProgress's rule). */
export function latestAttemptRows<T extends GradebookSubRow>(rows: T[]): T[] {
  if (rows.length === 0) return [];
  const latest = [...rows].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0];
  return latest.session_id ? rows.filter((r) => r.session_id === latest.session_id) : [latest];
}

function openState(started: boolean, pastDue: boolean): CellState {
  if (started) return pastDue ? "late" : "in-progress";
  return pastDue ? "missing" : "not-started";
}

const emptyCell = (state: CellState): GradebookCell => ({
  state,
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
});

/** One student's cell on a section test. */
export function sectionCell(testId: string, section: string | null, rows: GradebookSubRow[], pastDue: boolean): GradebookCell {
  const attempt = latestAttemptRows(rows);
  if (attempt.length === 0) return emptyCell(openState(false, pastDue));
  // Module 1 first: the Results page links the last (Module 2) row.
  const sorted = [...attempt].sort((a, b) => moduleRank(a.adaptive_track) - moduleRank(b.adaptive_track));
  const a = attemptScore(sorted, section);
  if (a.status === "Submitted" || a.status === "Late") {
    return {
      ...emptyCell("scored"),
      sat: a.score?.sat ?? null,
      detail: a.score?.modules ?? null,
      late: a.status === "Late",
      notes: a.score?.notes ?? [],
      pct: a.score?.pct ?? null,
      href: `/teacher/tests/${testId}/results/${sorted[sorted.length - 1].id}`,
      takenAt: lastSubmittedAt(sorted),
      attemptNumber: sorted[0].attempt_number ?? 1,
    };
  }
  const cell = emptyCell(openState(a.status === "In progress", pastDue));
  // An unfinished attempt keeps its module counts ("M1 20/27 · M2 —").
  return a.status === "In progress" ? { ...cell, detail: a.score?.modules ?? null, attemptNumber: sorted[0].attempt_number ?? 1 } : cell;
}

/** Last graded row of a section (the row its "View results" link opens). */
function lastGradedRowId(rows: GradebookSubRow[]): string | null {
  const graded = [...rows].filter((r) => isGraded(r.status)).sort((a, b) => moduleRank(a.adaptive_track) - moduleRank(b.adaptive_track));
  return graded[graded.length - 1]?.id ?? null;
}

/** One student's cell on a full-length SAT (latest attempt). */
export function fullLengthCell(
  children: FullLengthChildren,
  group: { rw: GradebookSubRow[]; math: GradebookSubRow[]; attemptNumber: number } | null,
  meta: FlAttemptMeta | null,
  scope: FlSectionScope,
  pastDue: boolean,
): GradebookCell {
  if (!group) return emptyCell(openState(false, pastDue));
  const s = scopedFlScore(fullLengthAttemptScore(group.rw, group.math, meta), scope);
  if (flFinished(s)) {
    // Open the first section this viewer may see.
    const [childId, rows] = scope.rw ? [children.rw, group.rw] : [children.math, group.math];
    const rowId = childId ? lastGradedRowId(rows) : null;
    return {
      ...emptyCell("scored"),
      sat: s.total,
      detail: s.score?.modules ?? null,
      late: s.status === "Late",
      notes: s.score?.notes ?? [],
      href: rowId ? `/teacher/tests/${childId}/results/${rowId}` : null,
      takenAt: lastSubmittedAt([...group.rw, ...group.math]),
      attemptNumber: group.attemptNumber,
      rw: s.rw.score?.sat ?? null,
      math: s.math.score?.sat ?? null,
    };
  }
  if (s.status === "Closed" || s.status === "Closed — Math not taken") {
    return { ...emptyCell("closed"), detail: s.score?.modules ?? null, attemptNumber: group.attemptNumber };
  }
  const started = s.status === "In progress" || s.status === "On break";
  const cell = emptyCell(openState(started, pastDue));
  return started ? { ...cell, detail: s.score?.modules ?? null, attemptNumber: group.attemptNumber } : cell;
}

/** Newest point first (by when it was taken, then by the column's date). */
function byNewest(a: ScorePoint & { order: string }, b: ScorePoint & { order: string }) {
  return (b.takenAt ?? b.order).localeCompare(a.takenAt ?? a.order);
}

/**
 * A student's summary over every column: latest Math / R&W (section tests
 * and the sections of a finished full-length SAT), est. total = the two
 * added, and the change of their most recent finished test vs their
 * previous one of the same subject.
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

  // Section rows: test → student → rows. Full-length rows: latest attempt per parent + student.
  const { attempts, rest } = groupFullLengthAttempts(rows, links);
  const sectionRows = new Map<string, GradebookSubRow[]>();
  for (const r of rest) {
    const k = `${r.test_id}:${r.student_id}`;
    sectionRows.set(k, [...(sectionRows.get(k) ?? []), r]);
  }
  const flLatest = new Map(latestFlAttemptGroups(attempts).map((g) => [`${g.parentId}:${g.studentId}`, g]));

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
        ? (() => {
            const g = flLatest.get(`${t.id}:${s.id}`) ?? null;
            return fullLengthCell(children, g, g ? input.flMeta.get(g.key) ?? null : null, scope, pastDue);
          })()
        : sectionCell(t.id, t.section, sectionRows.get(`${t.id}:${s.id}`) ?? [], pastDue);
      cellsByStudent.get(s.id)![t.id] = cell;
      cells.push(cell);
    }
    const done = cells.filter((c) => c.state === "scored");
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
      scored: done.filter((c) => c.sat != null).length,
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
