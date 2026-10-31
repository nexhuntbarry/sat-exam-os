import { isModule2Track } from "@/lib/student-exam";

export interface ProgressSubmission {
  id?: string;
  test_id?: string;
  student_id: string;
  status: string;
  session_id?: string | null;
  adaptive_track?: string | null;
  started_at?: string | null;
  correct_count?: number | null;
  total_questions?: number | null;
}

export interface TestProgress {
  /** Students the test is assigned to (individually or via a class), plus anyone who has work on it. */
  students: number;
  /** Students who have finished every module of their latest attempt. */
  finished: number;
  /** Mean of each finished student's score across all modules of that attempt. */
  avgScore: number | null;
}

export interface StudentTestProgress {
  status: "Not started" | "In progress" | "Submitted";
  /** Percent correct across the graded modules of a finished attempt. */
  score: number | null;
  /** Row to open for a finished attempt's detail (the Module 2 row when there is one). */
  detailSubmissionId: string | null;
  /** Module the student is on while In progress (1 or 2), else null. */
  currentModule: number | null;
  /** Modules in the latest attempt (2 for a two-module test, 1 otherwise / legacy). */
  moduleCount: number;
}

const graded = (s: string) => s === "Submitted" || s === "Late";

/**
 * One student's progress on one test, from that student's submission rows.
 * Submitted when their latest attempt has every module graded; In progress
 * when that attempt has a module open (or Module 1 is in but Module 2 isn't).
 */
export function studentTestProgress(
  subs: ProgressSubmission[],
  twoModules: boolean,
): StudentTestProgress {
  if (subs.length === 0) {
    return { status: "Not started", score: null, detailSubmissionId: null, currentModule: null, moduleCount: twoModules ? 2 : 1 };
  }
  // Latest attempt = the session of the most recently started row.
  const latest = [...subs].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0];
  const attempt = latest.session_id ? subs.filter((s) => s.session_id === latest.session_id) : [latest];
  // Rows from before the test had a Module 2 carry no track: that attempt
  // was a single module, so one graded row finishes it.
  const legacy = attempt.every((s) => !s.adaptive_track);
  const done = twoModules && !legacy
    ? attempt.some((s) => isModule2Track(s.adaptive_track) && graded(s.status)) &&
      attempt.some((s) => !isModule2Track(s.adaptive_track) && graded(s.status))
    : attempt.some((s) => graded(s.status));
  const moduleCount = twoModules && !legacy ? 2 : 1;
  const gradedRows = attempt.filter((s) => graded(s.status));
  if (!done) {
    const started = attempt.some((s) => s.status === "In Progress") || gradedRows.length > 0;
    // On Module 2 once its row exists or Module 1 is graded (handoff pending).
    const onModule2 =
      moduleCount === 2 &&
      attempt.some((s) => isModule2Track(s.adaptive_track) || (!isModule2Track(s.adaptive_track) && graded(s.status)));
    return {
      status: started ? "In progress" : "Not started",
      score: null,
      detailSubmissionId: null,
      currentModule: started ? (onModule2 ? 2 : 1) : null,
      moduleCount,
    };
  }
  const correct = gradedRows.reduce((n, s) => n + (s.correct_count ?? 0), 0);
  const total = gradedRows.reduce((n, s) => n + (s.total_questions ?? 0), 0);
  const detail = gradedRows.find((s) => isModule2Track(s.adaptive_track)) ?? gradedRows[0];
  return {
    status: "Submitted",
    score: total > 0 ? (correct / total) * 100 : null,
    detailSubmissionId: detail.id ?? null,
    currentModule: null,
    moduleCount,
  };
}

/**
 * Per-student progress for one test. Submissions rows are per module
 * (a Module 1 + Module 2 test gives each student two rows), so counting
 * rows double-counts students. Here each student is counted once:
 * finished when their latest attempt has every module graded.
 */
export function summarizeTestProgress(
  rows: ProgressSubmission[],
  assignedStudentIds: Iterable<string>,
  twoModules: boolean,
): TestProgress {
  const students = new Set(assignedStudentIds);
  const byStudent = new Map<string, ProgressSubmission[]>();
  for (const r of rows) {
    students.add(r.student_id);
    byStudent.set(r.student_id, [...(byStudent.get(r.student_id) ?? []), r]);
  }

  let finished = 0;
  const scores: number[] = [];
  for (const subs of byStudent.values()) {
    const p = studentTestProgress(subs, twoModules);
    if (p.status !== "Submitted") continue;
    finished++;
    if (p.score !== null) scores.push(p.score);
  }

  return {
    students: students.size,
    finished,
    avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
  };
}
