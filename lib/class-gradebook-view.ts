// lib/class-gradebook-view.ts
//
// Class gradebook ("Scores" on a class page): the shapes the grid renders
// and the pure view helpers shared by the screen, the CSV download and the
// printout (filter, sort, score tiers, CSV rows). No imports, so the
// client component can use it. The data is built by lib/class-gradebook
// (reads) + lib/class-gradebook-shape (scoring), never here.

/** Column subject: a section test, a full-length SAT parent, or a test with no known section. */
export type GradebookKind = "math" | "rw" | "fl" | "other";

/**
 * Where a student stands on a test (their latest attempt):
 * scored = finished (Submitted or Late); late = started, not finished,
 * past the due date; missing = not started, past the due date; closed =
 * a full-length attempt closed before it was finished.
 */
export type CellState = "scored" | "in-progress" | "late" | "not-started" | "missing" | "closed";

export interface GradebookColumn {
  id: string;
  name: string;
  kind: GradebookKind;
  /** Date the column sorts and filters by: due date, else open date, else created. */
  date: string | null;
  dueDate: string | null;
  /** The test's results page. */
  href: string;
  /** Class average of finished scores (section 200–800, full-length total 400–1600). */
  avg: number | null;
  /** Full-length only: section averages (null when hidden from this viewer). */
  avgRw: number | null;
  avgMath: number | null;
  /** Mean % correct of finished cells (secondary to avg). */
  avgPct: number | null;
  /** Students with a finished score. */
  scored: number;
  /** Students with a finished attempt (the class page's "x/y submitted"). */
  submitted: number;
  /** Students with an unfinished latest attempt (a retake in progress counts). */
  inProgress: number;
}

export interface GradebookCell {
  /**
   * Where the shown attempt stands. "scored" = the latest attempt, or the
   * latest finished one when a retake isn't finished (see `retake`).
   */
  state: CellState;
  /** Exact status when it says more than the state ("Closed — Math not taken"). */
  statusLabel: string | null;
  /** Section score (200–800) or full-length total (400–1600); null until finished. */
  sat: number | null;
  /** "M1 20/27 · M2 18/27" (section) or "R&W 650 · Math 700" (full-length). */
  detail: string | null;
  /** Finished after the due date. */
  late: boolean;
  /** "M1: 1 question in review, not scored" … */
  notes: string[];
  /** Percent correct (secondary, hover only). */
  pct: number | null;
  /** That student's result, when finished and visible to the viewer. */
  href: string | null;
  /** When the attempt was submitted (last module). */
  takenAt: string | null;
  attemptNumber: number | null;
  /** Full-length sections (null when not finished or hidden from this viewer). */
  rw: number | null;
  math: number | null;
  /** The score is from an earlier attempt: a later one is in progress (or was closed unfinished). */
  retake: { state: "in-progress" | "closed"; attemptNumber: number | null } | null;
}

export interface ScorePoint {
  score: number;
  testId: string;
  testName: string;
  takenAt: string | null;
}

export interface StudentSummary {
  /** Latest finished Math score: a Math test or the Math section of a full-length SAT. */
  latestMath: ScorePoint | null;
  latestRw: ScorePoint | null;
  /** latestMath + latestRw (null unless both exist). */
  estTotal: number | null;
  /**
   * The student's most recent finished test vs their previous finished
   * test of the same subject (Math vs Math, R&W vs R&W, full-length total
   * vs full-length total). null when there's no earlier one.
   */
  change: { delta: number; kind: GradebookKind; latest: ScorePoint; previous: ScorePoint } | null;
}

export interface GradebookRow {
  studentId: string;
  name: string;
  email: string;
  /** testId → cell (every column has one). */
  cells: Record<string, GradebookCell>;
  summary: StudentSummary;
}

export interface Gradebook {
  /** Newest first. */
  columns: GradebookColumn[];
  /** Alphabetical by name. */
  rows: GradebookRow[];
  /** Sections this viewer may see (a single-subject teacher sees one). */
  scope: { rw: boolean; math: boolean };
  /** Class averages of the summary columns. */
  averages: { latestMath: number | null; latestRw: number | null; estTotal: number | null };
}

// ------------------------------------------------------------ filters

export type SubjectFilter = "all" | "math" | "rw" | "fl";

export interface GradebookFilter {
  subject: SubjectFilter;
  /** yyyy-mm-dd, inclusive; empty = open-ended. */
  from: string;
  to: string;
}

export const NO_FILTER: GradebookFilter = { subject: "all", from: "", to: "" };

// Calendar day in the school's time zone (lib/datetime shows dates in New York time).
const NY_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** "2026-11-03" for an ISO timestamp, as a New York calendar day. */
export function nyDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : NY_DAY.format(d);
}

/** Columns matching the subject + date range (a column with no date is kept only without a range). */
export function filterColumns(columns: GradebookColumn[], f: GradebookFilter): GradebookColumn[] {
  return columns.filter((c) => {
    if (f.subject !== "all" && c.kind !== f.subject) return false;
    if (!f.from && !f.to) return true;
    if (!c.date) return false;
    const day = nyDay(c.date);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    return true;
  });
}

// ------------------------------------------------------------- sorting

/** "name", "test:<id>", "latestMath", "latestRw", "estTotal", "change". */
export type SortKey = string;
export type SortDir = "asc" | "desc";

function sortValue(row: GradebookRow, key: SortKey): number | null {
  if (key.startsWith("test:")) return row.cells[key.slice(5)]?.sat ?? null;
  switch (key) {
    case "latestMath":
      return row.summary.latestMath?.score ?? null;
    case "latestRw":
      return row.summary.latestRw?.score ?? null;
    case "estTotal":
      return row.summary.estTotal;
    case "change":
      return row.summary.change?.delta ?? null;
    default:
      return null;
  }
}

/** The sort to apply: sorting by a test column the filter hid falls back to name (A → Z). */
export function effectiveSort(columns: GradebookColumn[], key: SortKey, dir: SortDir): { key: SortKey; dir: SortDir } {
  if (key.startsWith("test:") && !columns.some((c) => `test:${c.id}` === key)) return { key: "name", dir: "asc" };
  return { key, dir };
}

/** Sorted copy. Students without a value always go last; ties by name. */
export function sortRows(rows: GradebookRow[], key: SortKey, dir: SortDir): GradebookRow[] {
  const byName = (a: GradebookRow, b: GradebookRow) => a.name.localeCompare(b.name) || a.studentId.localeCompare(b.studentId);
  const sign = dir === "asc" ? 1 : -1;
  if (key === "name") return [...rows].sort((a, b) => sign * byName(a, b));
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va == null && vb == null) return byName(a, b);
    if (va == null) return 1;
    if (vb == null) return -1;
    return sign * (va - vb) || byName(a, b);
  });
}

// --------------------------------------------------------- score tiers

export type ScoreTier = "low" | "mid" | "high";

/**
 * Light color scale: section score under 500 / 500–649 / 650+; a
 * full-length total uses the same cut points doubled (under 1000 /
 * 1000–1299 / 1300+).
 */
export function scoreTier(sat: number, kind: GradebookKind): ScoreTier {
  const k = kind === "fl" ? 2 : 1;
  if (sat >= 650 * k) return "high";
  if (sat >= 500 * k) return "mid";
  return "low";
}

/** Shape marker for each tier, so the scale reads without color (and in black and white). */
export const TIER_MARK: Record<ScoreTier, string> = { high: "●", mid: "◐", low: "○" };
export const TIER_LABEL: Record<ScoreTier, string> = { high: "650+", mid: "500–649", low: "Under 500" };
const FL_TIER_LABEL: Record<ScoreTier, string> = { high: "1300+", mid: "1000–1299", low: "Under 1000" };

/** The band's range in words, on the column's scale. */
export function tierLabel(tier: ScoreTier, kind: GradebookKind): string {
  return (kind === "fl" ? FL_TIER_LABEL : TIER_LABEL)[tier];
}

// --------------------------------------------------------------- text

export const STATE_LABEL: Record<CellState, string> = {
  scored: "Submitted",
  "in-progress": "In progress",
  late: "Late",
  "not-started": "Not started",
  missing: "Missing",
  closed: "Closed",
};

/** What a status means, for the cell's tooltip. */
export const STATE_HINT: Record<CellState, string> = {
  scored: "Submitted",
  "in-progress": "Started, not submitted yet",
  late: "Started, not submitted, and past the due date",
  "not-started": "Not started yet",
  missing: "Not started, and past the due date",
  closed: "Full-length attempt closed before it was finished",
};

/** Status word shown in a cell without a score. */
export function cellLabel(cell: Pick<GradebookCell, "state" | "statusLabel">): string {
  return cell.statusLabel ?? STATE_LABEL[cell.state];
}

/** What the cell's status means, for its tooltip (the real closed reason for a full-length attempt). */
export function cellHint(cell: Pick<GradebookCell, "state" | "statusLabel">): string {
  if (cell.state === "closed" && cell.statusLabel === "Closed — Math not taken") {
    return "Full-length attempt closed: the Math section was never started";
  }
  return STATE_HINT[cell.state];
}

/** "Retake in progress" / "Retake closed" for a score from an earlier attempt. */
export function retakeLabel(cell: Pick<GradebookCell, "retake">): string | null {
  if (!cell.retake) return null;
  return cell.retake.state === "closed" ? "Retake closed" : "Retake in progress";
}

/** "+40", "−20", "±0". */
export function formatChange(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return "±0";
}

export const KIND_LABEL: Record<GradebookKind, string> = { math: "Math", rw: "R&W", fl: "Full-length", other: "Test" };

// ----------------------------------------------------------------- CSV

/** CSV cell text for a grid cell: the score, else the status. */
export function cellText(cell: GradebookCell | undefined): string {
  if (!cell) return "";
  if (cell.state === "scored") {
    const notes = [cell.late ? "late" : null, retakeLabel(cell)?.toLowerCase() ?? null].filter(Boolean);
    return cell.sat != null ? `${cell.sat}${notes.length ? ` (${notes.join(", ")})` : ""}` : "Submitted";
  }
  return cellLabel(cell);
}

/**
 * The grid as CSV rows (header first, class average last), same columns
 * as on screen: student, one column per test, then the summary columns
 * the viewer sees.
 */
export function gradebookCsvRows(gb: Pick<Gradebook, "scope" | "averages">, columns: GradebookColumn[], rows: GradebookRow[]): (string | number)[][] {
  const both = gb.scope.rw && gb.scope.math;
  const header = [
    "Student",
    "Email",
    ...columns.map((c) => `${c.name} (${KIND_LABEL[c.kind]})`),
    ...(gb.scope.math ? ["Latest Math"] : []),
    ...(gb.scope.rw ? ["Latest R&W"] : []),
    ...(both ? ["Est. total"] : []),
    "Change",
  ];
  const body = rows.map((r) => [
    r.name,
    r.email,
    ...columns.map((c) => cellText(r.cells[c.id])),
    ...(gb.scope.math ? [r.summary.latestMath?.score ?? ""] : []),
    ...(gb.scope.rw ? [r.summary.latestRw?.score ?? ""] : []),
    ...(both ? [r.summary.estTotal ?? ""] : []),
    // A plain number (40, -20) so spreadsheets can sort it.
    r.summary.change ? r.summary.change.delta : "",
  ]);
  const avg = [
    "Class average",
    "",
    ...columns.map((c) => c.avg ?? ""),
    ...(gb.scope.math ? [gb.averages.latestMath ?? ""] : []),
    ...(gb.scope.rw ? [gb.averages.latestRw ?? ""] : []),
    ...(both ? [gb.averages.estTotal ?? ""] : []),
    "",
  ];
  return [header, ...body, avg];
}

/**
 * Quote every cell, and neutralise spreadsheet formula injection (a value
 * starting with = + - @ is prefixed with '), like the results export.
 * Plain numbers ("-20") are left alone.
 */
export function csvLine(cells: (string | number)[]): string {
  return cells
    .map((value) => {
      let v = String(value);
      if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = `'${v}`;
      return `"${v.replace(/"/g, '""')}"`;
    })
    .join(",");
}

/** Full CSV text (BOM so Excel reads UTF-8 names). */
export function gradebookCsv(gb: Pick<Gradebook, "scope" | "averages">, columns: GradebookColumn[], rows: GradebookRow[]): string {
  return "﻿" + gradebookCsvRows(gb, columns, rows).map(csvLine).join("\r\n") + "\r\n";
}

/**
 * Printed tables for a wide grid: at most `size` tests each (the Student
 * column repeats on every one). The summary columns go on the last table
 * when it has room (≤ size − 4 tests), else on a table of their own.
 */
export function printGroups(columns: GradebookColumn[], size = 8): { columns: GradebookColumn[]; summary: boolean }[] {
  const groups: { columns: GradebookColumn[]; summary: boolean }[] = [];
  for (let i = 0; i < columns.length; i += size) groups.push({ columns: columns.slice(i, i + size), summary: false });
  const last = groups[groups.length - 1];
  if (last && last.columns.length <= size - 4) last.summary = true;
  else groups.push({ columns: [], summary: true });
  return groups;
}

/** Query string carrying the view (filters + sort) to the print page. */
export function viewQuery(f: GradebookFilter, sort: SortKey, dir: SortDir): string {
  const q = new URLSearchParams();
  if (f.subject !== "all") q.set("subject", f.subject);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (sort !== "name") q.set("sort", sort);
  if (dir !== "asc") q.set("dir", dir);
  return q.toString();
}

/** Inverse of viewQuery (bad values fall back to the defaults). */
export function parseViewQuery(sp: Record<string, string | undefined>): { filter: GradebookFilter; sort: SortKey; dir: SortDir } {
  const subject = (["all", "math", "rw", "fl"] as const).find((s) => s === sp.subject) ?? "all";
  const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
  const sort = sp.sort && /^(name|latestMath|latestRw|estTotal|change|test:[\w-]+)$/.test(sp.sort) ? sp.sort : "name";
  return { filter: { subject, from: day(sp.from), to: day(sp.to) }, sort, dir: sp.dir === "desc" ? "desc" : "asc" };
}
