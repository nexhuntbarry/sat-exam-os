// lib/full-length-score.ts
//
// Full-length SAT results (plan .omc/plans/full-length-sat.md, Phase 3).
// One full-length attempt = the student's rows on the parent's two section
// children with the same attempt_number. Each section is scored exactly as
// a section test is (attemptScore / scoreDisplay, lib/scoring curve); the
// total is R&W + Math (combineSectionScores), 400–1600, and stays null
// until both sections are finished. Nothing here is stored: totals are
// worked out when read, so a rescore of a child row flows through.

import type { SupabaseClient } from "@supabase/supabase-js";
import { attemptScore, averageSat, pctOf, type AttemptScore, type ScoreDisplay, type ScoreModule } from "@/lib/score-display";
import { combineSectionScores } from "@/lib/scoring";
import type { ProgressSubmission } from "@/lib/test-progress";
import type { FullLengthChildren, FullLengthLinks } from "@/lib/full-length";

export const FL_RW_SECTION = "Reading & Writing";
export const FL_MATH_SECTION = "Math";

/** A submission row on a full-length child (any subset of columns the caller selected). */
export type FlScoreRow = ProgressSubmission & {
  test_id: string;
  attempt_number?: number | null;
  submitted_at?: string | null;
  time_spent_seconds?: number | null;
};

/** The full_length_attempts columns the score needs. */
export interface FlAttemptMeta {
  closed_at: string | null;
  closed_reason: string | null;
  time_multiplier?: number | string | null;
}

export type FullLengthStatus =
  | "Not started"
  | "In progress"
  | "On break"
  | "Submitted"
  | "Late"
  | "Closed — Math not taken"
  | "Closed";

export interface FullLengthScore {
  /** R&W + Math (400–1600); null until both sections are finished. */
  total: number | null;
  /** Each section scored like a section test (SAT 200–800, M1/M2 counts, notes). */
  rw: AttemptScore;
  math: AttemptScore;
  status: FullLengthStatus;
  /** Where an unfinished attempt is: "R&W · Module 2", "Break", "Math · Module 1". */
  current: string | null;
  /**
   * The ScoreCell value for list pages: `sat` = the total, `modules` =
   * "R&W 650 · Math 700", notes prefixed by section. null = not started.
   */
  score: ScoreDisplay | null;
  /** Module 2 difficulty served: "Easy" / "Hard" (adaptive), "" (fixed), null (no Module 2 row). */
  rwTrack: string | null;
  mathTrack: string | null;
}

const isDone = (s: string) => s === "Submitted" || s === "Late";

/** "Easy" / "Hard" for an adaptive Module 2, "" for a fixed one, null when there is no Module 2 row. */
export function module2TrackLabel(rows: Pick<ProgressSubmission, "adaptive_track">[]): string | null {
  const t = rows.find((r) => r.adaptive_track && r.adaptive_track !== "module_1")?.adaptive_track;
  if (!t) return null;
  return t === "module_2_easy" ? "Easy" : t === "module_2_hard" ? "Hard" : "";
}

/** Is a 'closed' attempt really closed? A math_not_started close that lost a race with a Math start isn't (same rule as flState). */
function isClosed(attempt: FlAttemptMeta | null | undefined, mathRows: unknown[]): boolean {
  if (!attempt?.closed_at) return false;
  return attempt.closed_reason !== "math_not_started" || mathRows.length === 0;
}

/**
 * One full-length attempt's score. `rwRows` / `mathRows` are that
 * attempt's rows on the R&W / Math child; `attempt` its
 * full_length_attempts row when known (for the closed states).
 */
export function fullLengthAttemptScore(
  rwRows: FlScoreRow[],
  mathRows: FlScoreRow[],
  attempt?: FlAttemptMeta | null,
): FullLengthScore {
  const rw = attemptScore(rwRows, FL_RW_SECTION);
  const math = attemptScore(mathRows, FL_MATH_SECTION);
  const rwDone = isDone(rw.status);
  const mathDone = isDone(math.status);
  const total = rwDone && mathDone ? combineSectionScores(rw.score?.sat ?? null, math.score?.sat ?? null) : null;

  let status: FullLengthStatus;
  let current: string | null = null;
  if (rwDone && mathDone) status = rw.status === "Late" || math.status === "Late" ? "Late" : "Submitted";
  else if (isClosed(attempt, mathRows)) status = attempt?.closed_reason === "math_not_started" ? "Closed — Math not taken" : "Closed";
  else if (rwRows.length === 0 && mathRows.length === 0) status = "Not started";
  else if (rwDone && mathRows.length === 0) {
    status = "On break";
    current = "Break";
  } else {
    status = "In progress";
    current = mathRows.length > 0 ? `Math · Module ${math.module?.n ?? 1}` : `R&W · Module ${rw.module?.n ?? 1}`;
  }

  let score: ScoreDisplay | null = null;
  if (rwRows.length > 0 || mathRows.length > 0) {
    const graded = [...rw.modules, ...math.modules].filter((m) => m.graded);
    const correct = graded.reduce((n, m) => n + (m.correct ?? 0), 0);
    const questions = graded.reduce((n, m) => n + (m.total ?? 0), 0);
    score = {
      sat: total,
      modules: `R&W ${rw.score?.sat ?? "—"} · Math ${math.score?.sat ?? "—"}`,
      pct: total != null ? pctOf(correct, questions) : null,
      notes: [
        ...(rw.score?.notes ?? []).map((n) => `R&W ${n}`),
        ...(math.score?.notes ?? []).map((n) => `Math ${n}`),
      ],
    };
  }

  return {
    total,
    rw,
    math,
    status,
    current,
    score,
    rwTrack: module2TrackLabel(rwRows),
    mathTrack: module2TrackLabel(mathRows),
  };
}

/** Module 1 / Module 2 cells of a section: "22/27", "—" (open) or "" (not reached). */
export function flModuleCells(a: AttemptScore): [string, string] {
  const cell = (m: ScoreModule | undefined) => (!m ? "" : m.graded ? `${m.correct ?? 0}/${m.total ?? 0}` : "—");
  return [cell(a.modules[0]), cell(a.modules[1])];
}

/** Finished with a total (Submitted / Late). */
export function flFinished(s: FullLengthScore): boolean {
  return s.status === "Submitted" || s.status === "Late";
}

/** "Submitted" / "Late" / "In progress" … with the module or break for an unfinished attempt. */
export function flStatusText(s: FullLengthScore): string {
  return s.current && s.status === "In progress" ? `In progress · ${s.current}` : s.status;
}

/**
 * The shared attempt badge (components/ui/StatusBadge) for a full-length
 * status: "On break" is an in-progress attempt, a closed one is shown in
 * the Late (warning) tone with its own label.
 */
export function flBadge(s: FullLengthScore): { status: "Not started" | "In progress" | "Submitted" | "Late"; label?: string } {
  switch (s.status) {
    case "On break":
      return { status: "In progress", label: "On break" };
    case "Closed — Math not taken":
    case "Closed":
      return { status: "Late", label: s.status };
    default:
      return { status: s.status };
  }
}

/**
 * The score as a viewer limited to `scope` may see it: the total stays,
 * the hidden section's score, module counts, track and notes are dropped
 * (so they never reach client props), and the combined cell lists the
 * visible sections only. Unchanged when both sections are visible.
 */
export function scopedFlScore(s: FullLengthScore, scope: { rw: boolean; math: boolean }): FullLengthScore {
  if (scope.rw && scope.math) return s;
  const hidden = (a: AttemptScore): AttemptScore => ({ score: null, status: a.status, module: null, modules: [] });
  const rw = scope.rw ? s.rw : hidden(s.rw);
  const math = scope.math ? s.math : hidden(s.math);
  const parts = [
    ...(scope.rw ? [`R&W ${s.rw.score?.sat ?? "—"}`] : []),
    ...(scope.math ? [`Math ${s.math.score?.sat ?? "—"}`] : []),
  ];
  return {
    ...s,
    rw,
    math,
    rwTrack: scope.rw ? s.rwTrack : null,
    mathTrack: scope.math ? s.mathTrack : null,
    score: s.score
      ? {
          sat: s.total,
          modules: parts.join(" · "),
          pct: null,
          notes: [
            ...(scope.rw ? (s.rw.score?.notes ?? []).map((n) => `R&W ${n}`) : []),
            ...(scope.math ? (s.math.score?.notes ?? []).map((n) => `Math ${n}`) : []),
          ],
        }
      : null,
  };
}

/** A full-length score in the AttemptScore shape the list pages already render (score = the combined cell). */
export function asAttemptScore(s: FullLengthScore): AttemptScore {
  return { score: s.score, status: flBadge(s).status, module: null, modules: [] };
}

// ------------------------------------------------------------- grouping

export interface FlAttemptGroup<T extends FlScoreRow> {
  parentId: string;
  studentId: string;
  attemptNumber: number;
  /** `<parent>:<student>:<attempt>` (the closedFullLengthAttemptKeys format). */
  key: string;
  rw: T[];
  math: T[];
}

export const flAttemptKey = (parentId: string, studentId: string, attemptNumber: number) =>
  `${parentId}:${studentId}:${attemptNumber}`;

/**
 * Split rows into full-length attempts (rows of a child, grouped by
 * parent + student + attempt_number) and the rest (rows of any other
 * test, returned untouched in their original order).
 */
export function groupFullLengthAttempts<T extends FlScoreRow>(
  rows: T[],
  links: Pick<FullLengthLinks, "parentOf" | "childrenOf">,
): { attempts: FlAttemptGroup<T>[]; rest: T[] } {
  const groups = new Map<string, FlAttemptGroup<T>>();
  const rest: T[] = [];
  for (const r of rows) {
    const parentId = links.parentOf.get(r.test_id);
    if (!parentId) {
      rest.push(r);
      continue;
    }
    const n = r.attempt_number ?? 1;
    const key = flAttemptKey(parentId, r.student_id, n);
    let g = groups.get(key);
    if (!g) {
      g = { parentId, studentId: r.student_id, attemptNumber: n, key, rw: [], math: [] };
      groups.set(key, g);
    }
    const kids = links.childrenOf.get(parentId);
    if (kids?.math === r.test_id) g.math.push(r);
    else g.rw.push(r);
  }
  return { attempts: Array.from(groups.values()), rest };
}

/**
 * The attempt a row belongs to on list pages: a full-length child's row →
 * `fl:<parent>:<student>:<attempt>` (both sections together), any other row
 * → its session (or itself for a legacy single-module row), as before.
 */
export function attemptGroupKey(
  r: { id?: string; test_id: string; student_id: string; session_id?: string | null; attempt_number?: number | null },
  links: Pick<FullLengthLinks, "parentOf">,
): string {
  const parent = links.parentOf.get(r.test_id);
  if (parent) return `fl:${flAttemptKey(parent, r.student_id, r.attempt_number ?? 1)}`;
  return r.session_id ?? `solo:${r.id}`;
}

/** The test a row is listed under: a full-length child → its parent, else its own test. */
export function listedTestId(testId: string, links: Pick<FullLengthLinks, "parentOf">): string {
  return links.parentOf.get(testId) ?? testId;
}

/**
 * Score one attempt group from attemptGroupKey: a full-length attempt →
 * the combined score (total in `score.sat`), anything else → attemptScore
 * with the section, exactly as before.
 */
export function scoreAttemptGroup<T extends FlScoreRow>(
  rows: T[],
  links: Pick<FullLengthLinks, "parentOf" | "childrenOf">,
  section: string | null | undefined,
  meta?: Map<string, FlAttemptMeta>,
  /** Sections the viewer may see per parent (a single-subject teacher); default both. */
  scopeOf?: (parentId: string) => FlSectionScope,
): AttemptScore & { fullLength: FullLengthScore | null } {
  const parent = rows.length > 0 ? links.parentOf.get(rows[0].test_id) : undefined;
  if (!parent) return { ...attemptScore(rows, section), fullLength: null };
  const kids = links.childrenOf.get(parent);
  const full = fullLengthAttemptScore(
    rows.filter((r) => r.test_id !== kids?.math),
    rows.filter((r) => r.test_id === kids?.math),
    meta?.get(flAttemptKey(parent, rows[0].student_id, rows[0].attempt_number ?? 1)),
  );
  const fl = scopeOf ? scopedFlScore(full, scopeOf(parent)) : full;
  return { ...asAttemptScore(fl), fullLength: fl };
}

/** The latest attempt (highest attempt number) of each parent + student. */
export function latestFlAttemptGroups<T extends FlScoreRow>(groups: FlAttemptGroup<T>[]): FlAttemptGroup<T>[] {
  const best = new Map<string, FlAttemptGroup<T>>();
  for (const g of groups) {
    const k = `${g.parentId}:${g.studentId}`;
    const cur = best.get(k);
    if (!cur || g.attemptNumber > cur.attemptNumber) best.set(k, g);
  }
  return Array.from(best.values());
}

/** Last submitted_at among the rows (the attempt's "taken" date). */
export function lastSubmittedAt(rows: { submitted_at?: string | null }[]): string | null {
  return rows.map((r) => r.submitted_at).filter((d): d is string => Boolean(d)).sort().pop() ?? null;
}

/** Sum of time_spent_seconds, or null when no row has one. */
export function timeSpentSeconds(rows: { time_spent_seconds?: number | null }[]): number | null {
  return rows.some((r) => r.time_spent_seconds != null) ? rows.reduce((n, r) => n + (r.time_spent_seconds ?? 0), 0) : null;
}

/** Column averages of finished attempts (averageSat, same rounding as section tests). */
export function averageFullLength(scores: FullLengthScore[]): { total: number | null; rw: number | null; math: number | null } {
  const done = scores.filter(flFinished);
  return {
    total: averageSat(done.map((s) => s.total)),
    rw: averageSat(done.map((s) => s.rw.score?.sat)),
    math: averageSat(done.map((s) => s.math.score?.sat)),
  };
}

// ------------------------------------------------------------- reads

/**
 * full_length_attempts rows (closed state, extended time) keyed by
 * flAttemptKey, for these parents (optionally one student). Never throws:
 * on an error the map is empty and attempts read from their rows only.
 */
export async function loadFlAttemptMeta(
  db: SupabaseClient,
  parentIds: string[],
  studentId?: string,
): Promise<Map<string, FlAttemptMeta>> {
  const out = new Map<string, FlAttemptMeta>();
  if (parentIds.length === 0) return out;
  try {
    let q = db
      .from("full_length_attempts")
      .select("test_id, student_id, attempt_number, closed_at, closed_reason, time_multiplier")
      .in("test_id", parentIds);
    if (studentId) q = q.eq("student_id", studentId);
    const { data, error } = await q;
    if (error) {
      console.error("[full-length-score] attempts lookup failed", error.message);
      return out;
    }
    for (const a of (data ?? []) as (FlAttemptMeta & { test_id: string; student_id: string; attempt_number: number })[]) {
      out.set(flAttemptKey(a.test_id, a.student_id, a.attempt_number), a);
    }
  } catch (e) {
    console.error("[full-length-score] attempts lookup failed", e);
  }
  return out;
}

/** Score every group, with its attempt row when loaded. */
export function scoreGroups<T extends FlScoreRow>(
  groups: FlAttemptGroup<T>[],
  meta: Map<string, FlAttemptMeta>,
): (FlAttemptGroup<T> & { score: FullLengthScore; meta: FlAttemptMeta | null })[] {
  return groups.map((g) => {
    const m = meta.get(g.key) ?? null;
    return { ...g, meta: m, score: fullLengthAttemptScore(g.rw, g.math, m) };
  });
}

// ---------------------------------------------------- section visibility

/** Which sections a viewer may see in full (questions, module detail). */
export interface FlSectionScope {
  rw: boolean;
  math: boolean;
}

export const FL_ALL_SECTIONS: FlSectionScope = { rw: true, math: true };

/**
 * A teacher scoped to one subject sees the total plus their own section;
 * the other section's child is refused by getTeacherTestAccess (its
 * subject gate runs on the child's own section). Admins see both.
 */
export async function flSectionScope(
  db: SupabaseClient,
  user: { userId: string; role: string | null | undefined; isQa: boolean },
  children: FullLengthChildren,
): Promise<FlSectionScope> {
  if (user.role === "admin") return FL_ALL_SECTIONS;
  // Loaded lazily so the pure helpers above stay importable by unit tests
  // (teacher-access pulls in next/server through lib/qa).
  const { getTeacherTestAccess } = await import("@/lib/teacher-access");
  const [rw, math] = await Promise.all([
    children.rw ? getTeacherTestAccess(db, user, children.rw) : Promise.resolve({ mode: null }),
    children.math ? getTeacherTestAccess(db, user, children.math) : Promise.resolve({ mode: null }),
  ]);
  return { rw: rw.mode !== null, math: math.mode !== null };
}

// ----------------------------------------------------------------- CSV

/**
 * One per-question column: a question of one of the attempt's modules,
 * headed like the section export (`<prefix> Q<original number>`, e.g.
 * "RW M1 Q3", "Math M2 Hard Q12"). Build with flCsvQuestionColumns.
 */
export interface FlCsvQuestion {
  section: keyof FlSectionScope;
  header: string;
  questionId: string;
}

/**
 * Question columns in module order, numbers within each module ascending;
 * a repeated header gets " (2)" like the section export.
 */
export function flCsvQuestionColumns(
  modules: { section: keyof FlSectionScope; prefix: string; questions: { id: string; n: number }[] }[],
): FlCsvQuestion[] {
  const seen = new Map<string, number>();
  return modules.flatMap((m) =>
    [...m.questions]
      .sort((a, b) => a.n - b.n)
      .map((q) => {
        const base = `${m.prefix} Q${q.n}`;
        const k = (seen.get(base) ?? 0) + 1;
        seen.set(base, k);
        return { section: m.section, header: k > 1 ? `${base} (${k})` : base, questionId: q.id };
      }),
  );
}

/** Header of the full-length results CSV. The other section's columns are left out for a single-subject teacher. */
export function flCsvHeader(scope: FlSectionScope, questions: FlCsvQuestion[]): string[] {
  return [
    "Student", "Email", "Grade", "Class", "Attempt", "Status", "Total (400–1600)",
    ...(scope.rw ? ["R&W (200–800)"] : []),
    ...(scope.math ? ["Math (200–800)"] : []),
    ...(scope.rw ? ["R&W M1 Correct", "R&W M2 Correct", "R&W M2 Track"] : []),
    ...(scope.math ? ["Math M1 Correct", "Math M2 Correct", "Math M2 Track"] : []),
    "Extended Time", "Time Spent", "Submitted At",
    ...questions.filter((q) => scope[q.section]).map((q) => q.header),
  ];
}

export interface FlCsvInput {
  studentName: string;
  email: string;
  grade: string;
  className: string;
  attemptNumber: number;
  score: FullLengthScore;
  multiplier: number | null;
  timeSeconds: number | null;
  submittedAt: string | null;
  /** The attempt's submission row ids. */
  rowIds: string[];
  /** `${submissionId}:${questionId}` → the student's answer. */
  answers: Map<string, string>;
}

const moduleCell = (m: ScoreModule | undefined) => (m && m.graded ? `${m.correct ?? 0} / ${m.total ?? 0}` : "");

/** One CSV row, matching flCsvHeader(scope, questions). Counts are "22 / 27" so spreadsheets don't read dates. */
export function flCsvRow(input: FlCsvInput, scope: FlSectionScope, questions: FlCsvQuestion[]): (string | number)[] {
  const s = input.score;
  const t = input.timeSeconds;
  const sectionCells = (a: AttemptScore, track: string | null) => [moduleCell(a.modules[0]), moduleCell(a.modules[1]), track ?? ""];
  return [
    input.studentName,
    input.email,
    input.grade,
    input.className,
    input.attemptNumber,
    s.status,
    s.total ?? "",
    ...(scope.rw ? [s.rw.score?.sat ?? ""] : []),
    ...(scope.math ? [s.math.score?.sat ?? ""] : []),
    ...(scope.rw ? sectionCells(s.rw, s.rwTrack) : []),
    ...(scope.math ? sectionCells(s.math, s.mathTrack) : []),
    input.multiplier && input.multiplier > 1 ? `×${input.multiplier}` : "",
    t != null ? `${Math.floor(t / 60)}m ${t % 60}s` : "",
    input.submittedAt ? new Date(input.submittedAt).toISOString() : "",
    ...questions
      .filter((q) => scope[q.section])
      .map((q) => {
        for (const id of input.rowIds) {
          const v = input.answers.get(`${id}:${q.questionId}`);
          if (v !== undefined) return v;
        }
        return "";
      }),
  ];
}

/**
 * CSV row order: finished attempts first, oldest submission first, then
 * unfinished ones (oldest start first).
 */
export function flCsvOrder<T extends { score: FullLengthScore; submittedAt: string | null; startedAt?: string | null }>(rows: T[]): T[] {
  const done = rows.filter((r) => flFinished(r.score)).sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
  const open = rows
    .filter((r) => !flFinished(r.score))
    .sort((a, b) => (a.startedAt ?? a.submittedAt ?? "").localeCompare(b.startedAt ?? b.submittedAt ?? ""));
  return [...done, ...open];
}
