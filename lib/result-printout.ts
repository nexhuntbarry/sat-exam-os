// Server-side data for a STUDENT'S printed result (one attempt per student):
// header, the same score display as every screen (attemptScore), and the
// questions the student was graded on with their answers. Everything the
// student may not see is stripped HERE, not in the UI: correct answers,
// right/wrong marks and explanations follow the student's own visibility
// decision (lib/answer-visibility — results page, else open class review),
// whoever is printing.
import type { SupabaseClient } from "@supabase/supabase-js";
import { attemptScore, type AttemptScore } from "@/lib/score-display";
import { decideAnswerVisibility, loadAnswerVisibilityInputs, visibilityKey, type VisibilityDecision } from "@/lib/answer-visibility";
import { getTeacherTestAccess, getTestSections } from "@/lib/teacher-access";
import { getQaTestIds, getQaUserIds, onSide } from "@/lib/qa";
import { answerCandidates } from "@/lib/grade-submission";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { fullLengthLinks, type FullLengthChildren } from "@/lib/full-length";
import {
  FL_ALL_SECTIONS,
  flAttemptKey,
  flBadge,
  flFinished,
  flSectionScope,
  fullLengthAttemptScore,
  loadFlAttemptMeta,
  type FlSectionScope,
} from "@/lib/full-length-score";

export type PrintMode = "full" | "short";

export interface PrintOptions {
  mode: PrintMode;
  /** Explanations requested; only honoured where the student may see them. */
  explanations: boolean;
  /** Where explanations go when shown. */
  explanationsAt: "inline" | "end";
  /** Header + score only (CSV): skip loading the questions. */
  summaryOnly?: boolean;
}

export interface ResultChoice {
  label: string;
  text: string;
  image_url?: string | null;
}

export interface ResultQuestion {
  id: string;
  /** Number within its module (1..N), as printed on the blank test. */
  n: number;
  text: string;
  type: string;
  imageUrls: string[];
  choices: ResultChoice[];
  studentAnswer: string | null;
  /** null when the student may not see answers. */
  correctAnswer: string | null;
  /** "blank" = no answer; null when the student may not see answers. */
  outcome: "correct" | "wrong" | "blank" | null;
  explanation: string | null;
}

export interface ResultModule {
  label: string | null;
  /** Full-length SAT: the section this module belongs to (a divider goes before Math). */
  section?: "rw" | "math";
  questions: ResultQuestion[];
}

/** Full-length SAT printout header (plan Phase 3). */
export interface FullLengthPrintScore {
  /** R&W + Math (400–1600), null until both sections are finished. */
  total: number | null;
  rw: AttemptScore;
  math: AttemptScore;
  status: string;
  /** Sections printed in full (a single-subject teacher gets the total plus their own section). */
  scope: FlSectionScope;
}

export interface StudentResultPrintout {
  submissionId: string;
  studentId: string;
  studentName: string;
  className: string | null;
  testName: string;
  section: string | null;
  /** Last module's submitted_at. */
  takenAt: string | null;
  attempt: AttemptScore;
  /** Set for a full-length SAT attempt: `attempt` then holds the combined cell (sat = total). */
  fullLength?: FullLengthPrintScore;
  attemptNumber: number;
  visibility: VisibilityDecision;
  /** What this printout actually includes after clamping. */
  shows: { answers: boolean; explanations: boolean };
  /** Every graded question (short mode drops correct ones from `modules`). */
  grid: { module: string | null; n: number; outcome: ResultQuestion["outcome"] }[];
  modules: ResultModule[];
}

export interface Viewer {
  userId: string;
  role: string | null | undefined;
  isQa: boolean;
}

export class PrintAccessError extends Error {
  constructor(public status: 403 | 404, message: string) {
    super(message);
  }
}

const DONE = new Set(["Submitted", "Late"]);
const TRACK_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2",
  module_2_hard: "Module 2",
};

type SubRow = {
  id: string;
  test_id: string;
  student_id: string;
  status: string;
  session_id: string | null;
  adaptive_track: string | null;
  attempt_number: number | null;
  started_at: string | null;
  submitted_at: string | null;
  correct_count: number | null;
  total_questions: number | null;
};

/** studentId → display name and class name(s) (class groups, else the profile's class). */
/** For a teacher, only their own class groups' names are shown (null = no limit). */
async function visibleClassIds(db: SupabaseClient, viewer: Viewer): Promise<Set<string> | null> {
  if (viewer.role !== "teacher") return null;
  const { data } = await db.from("class_group_teachers").select("class_group_id").eq("teacher_id", viewer.userId);
  return new Set(((data ?? []) as { class_group_id: string }[]).map((r) => r.class_group_id));
}

/**
 * studentId → ", "-joined class names from class_group_members (the class
 * page's membership source). A teacher only sees their own classes' names.
 * Students with no visible class are absent from the map.
 */
export async function studentClassNames(
  db: SupabaseClient,
  viewer: Viewer,
  studentIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (studentIds.length === 0) return out;
  const [onlyClassIds, { data, error }] = await Promise.all([
    visibleClassIds(db, viewer),
    fetchAllRows((from, to) =>
      db.from("class_group_members").select("student_id, class_group_id, class_groups(name)")
        .in("student_id", studentIds).order("student_id").order("class_group_id").range(from, to)),
  ]);
  if (error) throw new Error(`class membership lookup failed: ${(error as { message?: string }).message ?? String(error)}`);
  const names = new Map<string, string[]>();
  for (const m of (data ?? []) as unknown as { student_id: string; class_group_id: string; class_groups: { name: string } | { name: string }[] | null }[]) {
    if (onlyClassIds && !onlyClassIds.has(m.class_group_id)) continue;
    const cg = Array.isArray(m.class_groups) ? m.class_groups[0] : m.class_groups;
    if (cg?.name) names.set(m.student_id, [...(names.get(m.student_id) ?? []), cg.name]);
  }
  for (const [id, list] of names) out.set(id, list.sort((a, b) => a.localeCompare(b)).join(", "));
  return out;
}

async function namesAndClasses(db: SupabaseClient, ids: string[], onlyClassIds: Set<string> | null = null) {
  const [usersRes, membersRes, profilesRes] = await Promise.all([
    db.from("users").select("id, display_name, email").in("id", ids),
    db.from("class_group_members").select("student_id, class_group_id, class_groups(name)").in("student_id", ids),
    db.from("student_profiles").select("user_id, class_group").in("user_id", ids),
  ]);
  const nameOf = new Map(((usersRes.data ?? []) as { id: string; display_name: string | null; email: string }[]).map((u) => [u.id, u.display_name || u.email]));
  const classesOf = new Map<string, string[]>();
  for (const m of (membersRes.data ?? []) as unknown as { student_id: string; class_group_id: string; class_groups: { name: string } | { name: string }[] | null }[]) {
    // A teacher sees only their own classes' names, not other teachers'.
    if (onlyClassIds && !onlyClassIds.has(m.class_group_id)) continue;
    const cg = Array.isArray(m.class_groups) ? m.class_groups[0] : m.class_groups;
    if (cg?.name) classesOf.set(m.student_id, [...(classesOf.get(m.student_id) ?? []), cg.name]);
  }
  const profileClass = new Map(((profilesRes.data ?? []) as { user_id: string; class_group: string | null }[]).map((p) => [p.user_id, p.class_group]));
  return (id: string) => {
    const classNames = classesOf.get(id) ?? (!onlyClassIds && profileClass.get(id) ? [profileClass.get(id)!] : []);
    return { studentName: nameOf.get(id) ?? "Student", className: classNames.join(", ") || null, classNames };
  };
}

/**
 * Students the viewer may print for this test, or null = every student.
 * Throws PrintAccessError when the viewer may not print this test at all.
 */
async function allowedStudents(db: SupabaseClient, viewer: Viewer, testId: string): Promise<Set<string> | null> {
  if (viewer.role === "student") return new Set([viewer.userId]);
  if (viewer.role !== "admin" && viewer.role !== "teacher") throw new PrintAccessError(403, "Forbidden");
  const access = await getTeacherTestAccess(db, viewer, testId);
  if (access.mode === null) throw new PrintAccessError(404, "Test not found");
  if (access.mode === "class") return access.studentAllowlist ?? new Set();
  return null;
}

/**
 * The printed questions of graded modules, in the order given, with the
 * student's answers and (only where they may see them) the key, marks and
 * explanations. Short mode keeps the missed questions only.
 */
async function buildModules(
  db: SupabaseClient,
  graded: { sub: SubRow; label: string | null; section?: "rw" | "math" }[],
  shows: { answers: boolean; explanations: boolean },
  opts: PrintOptions,
): Promise<{ modules: ResultModule[]; grid: StudentResultPrintout["grid"] }> {
  const modules: ResultModule[] = [];
  const grid: StudentResultPrintout["grid"] = [];
  if (graded.length === 0 || opts.summaryOnly) return { modules, grid };
  const { data: records, error } = await db
    .from("answer_records")
    .select(`submission_id, question_id, student_answer, correct_answer, is_correct,
      questions!inner(original_question_number, question_text, choices, question_type, explanation, image_urls)`)
    .in("submission_id", graded.map((g) => g.sub.id));
  if (error) throw new Error(`printout: answers lookup failed: ${error.message}`);
  type Rec = {
    submission_id: string; question_id: string; student_answer: string | null; correct_answer: string | null; is_correct: boolean | null;
    questions: { original_question_number: number; question_text: string; choices: ResultChoice[] | null; question_type: string; explanation: string | null; image_urls: string[] | null };
  };
  const recs = (records ?? []) as unknown as Rec[];
  for (const { sub, label, section } of graded) {
    const mine = recs.filter((r) => r.submission_id === sub.id).sort((a, b) => a.questions.original_question_number - b.questions.original_question_number);
    const questions: ResultQuestion[] = mine.map((r, i) => {
      const blank = !r.student_answer || r.student_answer.trim() === "";
      const outcome: ResultQuestion["outcome"] = !shows.answers ? null : blank ? "blank" : r.is_correct ? "correct" : "wrong";
      grid.push({ module: label, n: i + 1, outcome });
      return {
        id: r.question_id,
        n: i + 1,
        text: r.questions.question_text,
        type: r.questions.question_type,
        imageUrls: r.questions.image_urls ?? [],
        choices: Array.isArray(r.questions.choices) ? r.questions.choices : [],
        studentAnswer: blank ? null : r.student_answer,
        correctAnswer: shows.answers ? answerCandidates(r.correct_answer).join(" or ") || r.correct_answer : null,
        outcome,
        explanation: shows.explanations ? r.questions.explanation : null,
      };
    });
    modules.push({
      label,
      ...(section ? { section } : {}),
      // Answers hidden → the student sees no per-question review, so
      // neither does the paper. Short = missed (wrong or blank) only.
      questions: !shows.answers ? [] : opts.mode === "short" ? questions.filter((q) => q.outcome !== "correct") : questions,
    });
  }
  return { modules, grid };
}

/**
 * Printouts for the attempts identified by any one of their submission ids
 * (each id stands for that submission's whole two-module attempt). For a
 * student viewer, `submissionIds` may be empty = their latest finished attempt.
 */
export async function loadResultPrintouts(
  db: SupabaseClient,
  viewer: Viewer,
  testId: string,
  submissionIds: string[],
  opts: PrintOptions,
): Promise<StudentResultPrintout[]> {
  const allowed = await allowedStudents(db, viewer, testId);
  const { data: test } = await db.from("tests").select("id, test_name, module_2_id, is_adaptive").eq("id", testId).maybeSingle();
  if (!test) throw new PrintAccessError(404, "Test not found");
  if (viewer.role === "student" && !onSide(testId, await getQaTestIds(), viewer.isQa)) {
    throw new PrintAccessError(404, "Test not found");
  }

  // Full-length SAT parent: one printout per full-length attempt.
  const flKids = (await fullLengthLinks(db)).childrenOf.get(testId);
  if (flKids) return loadFullLengthPrintouts(db, viewer, testId, test.test_name as string, flKids, allowed, submissionIds, opts);

  // Resolve requested ids → attempts.
  let picked: SubRow[] = [];
  const cols = "id, test_id, student_id, status, session_id, adaptive_track, attempt_number, started_at, submitted_at, correct_count, total_questions";
  if (submissionIds.length > 0) {
    const { data, error } = await db.from("submissions").select(cols).eq("test_id", testId).in("id", submissionIds.slice(0, 500));
    if (error) throw new Error(`printout: submissions lookup failed: ${error.message}`);
    picked = (data ?? []) as SubRow[];
    if (picked.length !== new Set(submissionIds).size) throw new PrintAccessError(404, "Submission not found");
  } else if (viewer.role === "student") {
    const { data } = await db.from("submissions").select(cols).eq("test_id", testId).eq("student_id", viewer.userId)
      .in("status", ["Submitted", "Late"]).order("attempt_number", { ascending: false }).order("submitted_at", { ascending: false }).limit(1);
    picked = (data ?? []) as SubRow[];
    if (picked.length === 0) throw new PrintAccessError(404, "No finished attempt");
  }
  const qaUsers = await getQaUserIds();
  for (const s of picked) {
    if (allowed && !allowed.has(s.student_id)) throw new PrintAccessError(403, "Forbidden");
    if (!onSide(s.student_id, qaUsers, viewer.isQa)) throw new PrintAccessError(404, "Submission not found");
  }

  // Whole attempts (session siblings), one per requested attempt.
  const sessionIds = Array.from(new Set(picked.map((s) => s.session_id).filter((x): x is string => Boolean(x))));
  const siblings: SubRow[] = sessionIds.length
    ? (((await db.from("submissions").select(cols).in("session_id", sessionIds)).data ?? []) as SubRow[])
    : [];
  const attempts = new Map<string, SubRow[]>();
  for (const s of picked) {
    const key = s.session_id ?? `solo:${s.id}`;
    if (attempts.has(key)) continue;
    const rows = s.session_id ? siblings.filter((r) => r.session_id === s.session_id) : [s];
    rows.sort((a, b) => (a.adaptive_track === "module_1" ? 0 : 1) - (b.adaptive_track === "module_1" ? 0 : 1) || (a.started_at ?? "").localeCompare(b.started_at ?? ""));
    attempts.set(key, rows);
  }

  const studentIds = Array.from(new Set(picked.map((s) => s.student_id)));
  const [section, visInputs, people] = await Promise.all([
    getTestSections(db, [testId]).then((m) => m.get(testId) ?? null),
    loadAnswerVisibilityInputs(db, [testId], studentIds),
    namesAndClasses(db, studentIds, await visibleClassIds(db, viewer)),
  ]);

  const out: StudentResultPrintout[] = [];
  for (const rows of attempts.values()) {
    const head = rows[0];
    const studentId = head.student_id;
    const input = visInputs.get(visibilityKey(testId, studentId));
    // Same rule as the student's own result page: the results decision, or
    // an open class review when that one hides answers.
    let visibility: VisibilityDecision = input ? decideAnswerVisibility(input, "results") : { answers: false, explanations: false, source: "test" };
    if (!visibility.answers && input) {
      const review = decideAnswerVisibility(input, "class_review");
      if (review.answers) visibility = review;
    }
    const graded = rows.filter((r) => DONE.has(r.status));
    const shows = { answers: visibility.answers, explanations: visibility.answers && visibility.explanations && opts.explanations };

    const two = rows.length > 1;
    const { modules, grid } = await buildModules(
      db,
      graded.map((sub) => ({ sub, label: two ? (TRACK_LABEL[sub.adaptive_track ?? ""] ?? null) : null })),
      shows,
      opts,
    );
    out.push({
      submissionId: rows[rows.length - 1].id,
      studentId,
      ...people(studentId),
      testName: test.test_name as string,
      section,
      takenAt: graded.map((r) => r.submitted_at).filter((d): d is string => Boolean(d)).sort().pop() ?? null,
      attempt: attemptScore(rows, section),
      attemptNumber: head.attempt_number ?? 1,
      visibility,
      shows,
      grid,
      modules,
    });
  }
  out.sort((a, b) => a.studentName.localeCompare(b.studentName));
  return out;
}

const SUB_COLS = "id, test_id, student_id, status, session_id, adaptive_track, attempt_number, started_at, submitted_at, correct_count, total_questions";
const byModuleOrder = (a: SubRow, b: SubRow) =>
  (a.adaptive_track === "module_1" ? 0 : 1) - (b.adaptive_track === "module_1" ? 0 : 1) || (a.started_at ?? "").localeCompare(b.started_at ?? "");

/**
 * Full-length SAT printouts (plan Phase 3): each requested id stands for its
 * whole full-length attempt (both sections). The header carries the total,
 * R&W and Math; the grids and questions run R&W then Math. Visibility is
 * the parent's decision, so nothing shows until Math Module 2 is graded.
 */
async function loadFullLengthPrintouts(
  db: SupabaseClient,
  viewer: Viewer,
  testId: string,
  testName: string,
  kids: FullLengthChildren,
  allowed: Set<string> | null,
  submissionIds: string[],
  opts: PrintOptions,
): Promise<StudentResultPrintout[]> {
  const childIds = [kids.rw, kids.math].filter((x): x is string => Boolean(x));
  const meta = await loadFlAttemptMeta(db, [testId], viewer.role === "student" ? viewer.userId : undefined);
  const scoreOf = (rows: SubRow[], studentId: string, n: number) =>
    fullLengthAttemptScore(
      rows.filter((r) => r.test_id === kids.rw),
      rows.filter((r) => r.test_id === kids.math),
      meta.get(flAttemptKey(testId, studentId, n)),
    );

  let picked: SubRow[] = [];
  if (submissionIds.length > 0) {
    const { data, error } = await db.from("submissions").select(SUB_COLS).in("test_id", childIds).in("id", submissionIds.slice(0, 500));
    if (error) throw new Error(`printout: submissions lookup failed: ${error.message}`);
    picked = (data ?? []) as SubRow[];
    if (picked.length !== new Set(submissionIds).size) throw new PrintAccessError(404, "Submission not found");
  } else if (viewer.role === "student") {
    const { data } = await db.from("submissions").select(SUB_COLS).in("test_id", childIds).eq("student_id", viewer.userId);
    const mine = (data ?? []) as SubRow[];
    const numbers = Array.from(new Set(mine.map((r) => r.attempt_number ?? 1))).sort((a, b) => b - a);
    const n = numbers.find((k) => flFinished(scoreOf(mine.filter((r) => (r.attempt_number ?? 1) === k), viewer.userId, k)));
    if (n == null) throw new PrintAccessError(404, "No finished attempt");
    picked = mine.filter((r) => (r.attempt_number ?? 1) === n).slice(0, 1);
  }
  const qaUsers = await getQaUserIds();
  for (const s of picked) {
    if (allowed && !allowed.has(s.student_id)) throw new PrintAccessError(403, "Forbidden");
    if (!onSide(s.student_id, qaUsers, viewer.isQa)) throw new PrintAccessError(404, "Submission not found");
  }

  // Whole full-length attempts: every row of (student, attempt number) on both children.
  const studentIds = Array.from(new Set(picked.map((s) => s.student_id)));
  const wanted = new Set(picked.map((s) => `${s.student_id}:${s.attempt_number ?? 1}`));
  const { data: allRows, error: rowsError } = studentIds.length
    ? await fetchAllRows<SubRow>((from, to) =>
        db.from("submissions").select(SUB_COLS).in("test_id", childIds).in("student_id", studentIds)
          .order("id").range(from, to) as unknown as PromiseLike<{ data: SubRow[] | null; error: unknown }>)
    : { data: [] as SubRow[], error: null };
  if (rowsError) throw new Error(`printout: attempt rows lookup failed: ${(rowsError as { message?: string }).message ?? String(rowsError)}`);
  const attempts = new Map<string, SubRow[]>();
  for (const r of (allRows ?? []) as SubRow[]) {
    const k = `${r.student_id}:${r.attempt_number ?? 1}`;
    if (wanted.has(k)) attempts.set(k, [...(attempts.get(k) ?? []), r]);
  }

  const [visInputs, people, scope] = await Promise.all([
    loadAnswerVisibilityInputs(db, [testId], studentIds),
    namesAndClasses(db, studentIds, await visibleClassIds(db, viewer)),
    viewer.role === "teacher" ? flSectionScope(db, viewer, kids) : Promise.resolve(FL_ALL_SECTIONS),
  ]);

  const out: StudentResultPrintout[] = [];
  for (const rows of attempts.values()) {
    const rw = rows.filter((r) => r.test_id === kids.rw).sort(byModuleOrder);
    const math = rows.filter((r) => r.test_id === kids.math).sort(byModuleOrder);
    const head = rw[0] ?? math[0];
    const studentId = head.student_id;
    const n = head.attempt_number ?? 1;
    const fl = scoreOf(rows, studentId, n);
    const input = visInputs.get(visibilityKey(testId, studentId));
    let visibility: VisibilityDecision = input ? decideAnswerVisibility(input, "results") : { answers: false, explanations: false, source: "test" };
    if (!visibility.answers && input) {
      const review = decideAnswerVisibility(input, "class_review");
      if (review.answers) visibility = review;
    }
    const shows = { answers: visibility.answers, explanations: visibility.answers && visibility.explanations && opts.explanations };
    const label = (prefix: string, sub: SubRow) => `${prefix} · ${TRACK_LABEL[sub.adaptive_track ?? ""] ?? "Module"}`;
    const graded = [
      ...(scope.rw ? rw : []).filter((r) => DONE.has(r.status)).map((sub) => ({ sub, label: label("Reading and Writing", sub), section: "rw" as const })),
      ...(scope.math ? math : []).filter((r) => DONE.has(r.status)).map((sub) => ({ sub, label: label("Math", sub), section: "math" as const })),
    ];
    const { modules, grid } = await buildModules(db, graded, shows, opts);
    const ordered = [...rw, ...math];
    out.push({
      submissionId: ordered[ordered.length - 1].id,
      studentId,
      ...people(studentId),
      testName,
      section: null,
      takenAt: graded.map((g) => g.sub.submitted_at).filter((d): d is string => Boolean(d)).sort().pop() ?? null,
      attempt: { score: fl.score, status: flBadge(fl).status, module: null, modules: [] },
      fullLength: { total: fl.total, rw: fl.rw, math: fl.math, status: fl.status, scope },
      attemptNumber: n,
      visibility,
      shows,
      grid,
      modules,
    });
  }
  out.sort((a, b) => a.studentName.localeCompare(b.studentName));
  return out;
}

/** Latest finished full-length attempt per student (same picks as listPrintableAttempts). */
async function fullLengthPrintPicks(
  db: SupabaseClient,
  testId: string,
  kids: FullLengthChildren,
  allowed: Set<string> | null,
  viewer: Viewer,
): Promise<{ studentId: string; submissionId: string }[]> {
  const childIds = [kids.rw, kids.math].filter((x): x is string => Boolean(x));
  // Paged (PostgREST caps a response at 1000 rows); stable order for the pages.
  const { data, error } = await fetchAllRows<SubRow>((from, to) => {
    let q = db.from("submissions").select(SUB_COLS).in("test_id", childIds);
    if (allowed) q = q.in("student_id", Array.from(allowed));
    return q.order("id").range(from, to) as unknown as PromiseLike<{ data: SubRow[] | null; error: unknown }>;
  });
  if (error) throw new Error(`printout: submissions lookup failed: ${(error as { message?: string }).message ?? String(error)}`);
  const qaUsers = await getQaUserIds();
  const rows = ((data ?? []) as SubRow[]).filter((r) => onSide(r.student_id, qaUsers, viewer.isQa));
  const meta = await loadFlAttemptMeta(db, [testId]);
  const byStudent = new Map<string, SubRow[]>();
  for (const r of rows) byStudent.set(r.student_id, [...(byStudent.get(r.student_id) ?? []), r]);
  const picks: { studentId: string; submissionId: string }[] = [];
  for (const [studentId, list] of byStudent) {
    const latest = Math.max(...list.map((r) => r.attempt_number ?? 1));
    const attemptRows = list.filter((r) => (r.attempt_number ?? 1) === latest);
    const fl = fullLengthAttemptScore(
      attemptRows.filter((r) => r.test_id === kids.rw),
      attemptRows.filter((r) => r.test_id === kids.math),
      meta.get(flAttemptKey(testId, studentId, latest)),
    );
    if (!flFinished(fl)) continue;
    const last = [...attemptRows].sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "")).pop()!;
    picks.push({ studentId, submissionId: last.id });
  }
  return picks;
}

/** "Jane Doe – Test name – 2026-11-07.pdf", safe for every OS. */
export function printoutFileName(p: Pick<StudentResultPrintout, "studentName" | "testName" | "takenAt">): string {
  const date = p.takenAt ? new Date(p.takenAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) : "not-submitted";
  return `${p.studentName} – ${p.testName} – ${date}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) + ".pdf";
}

export function parsePrintOptions(sp: { mode?: string; expl?: string; at?: string }): PrintOptions {
  return {
    mode: sp.mode === "short" ? "short" : "full",
    explanations: sp.expl === "1",
    explanationsAt: sp.at === "end" ? "end" : "inline",
  };
}

export interface PrintableAttempt {
  submissionId: string;
  studentId: string;
  studentName: string;
  className: string | null;
  /** Each class the student is in (the picker groups by these). */
  classNames: string[];
}

/** Every finished attempt (latest per student) the viewer may print, by name. */
export async function listPrintableAttempts(db: SupabaseClient, viewer: Viewer, testId: string): Promise<PrintableAttempt[]> {
  const allowed = await allowedStudents(db, viewer, testId);
  const flKids = (await fullLengthLinks(db)).childrenOf.get(testId);
  if (flKids) {
    const flPicks = await fullLengthPrintPicks(db, testId, flKids, allowed, viewer);
    if (flPicks.length === 0) return [];
    const flPeople = await namesAndClasses(db, flPicks.map((p) => p.studentId), await visibleClassIds(db, viewer));
    return flPicks
      .map((p) => ({ submissionId: p.submissionId, studentId: p.studentId, ...flPeople(p.studentId) }))
      .sort((a, b) => a.studentName.localeCompare(b.studentName));
  }
  let q = db
    .from("submissions")
    .select("id, student_id, status, session_id, adaptive_track, attempt_number, started_at, correct_count, total_questions")
    .eq("test_id", testId);
  if (allowed) q = q.in("student_id", Array.from(allowed));
  const { data, error } = await q;
  if (error) throw new Error(`printout: submissions lookup failed: ${error.message}`);
  const qaUsers = await getQaUserIds();
  const rows = ((data ?? []) as SubRow[]).filter((r) => onSide(r.student_id, qaUsers, viewer.isQa));
  // Latest attempt per student; an attempt = its session's rows.
  const byStudent = new Map<string, SubRow[]>();
  for (const r of rows) byStudent.set(r.student_id, [...(byStudent.get(r.student_id) ?? []), r]);
  const picks: { studentId: string; submissionId: string }[] = [];
  for (const [studentId, list] of byStudent) {
    const latest = Math.max(...list.map((r) => r.attempt_number ?? 1));
    const attemptRows = list.filter((r) => (r.attempt_number ?? 1) === latest);
    const status = attemptScore(attemptRows, null).status;
    if (status !== "Submitted" && status !== "Late") continue;
    const last = [...attemptRows].sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "")).pop()!;
    picks.push({ studentId, submissionId: last.id });
  }
  if (picks.length === 0) return [];
  const people = await namesAndClasses(db, picks.map((p) => p.studentId), await visibleClassIds(db, viewer));
  return picks
    .map((p) => ({ submissionId: p.submissionId, studentId: p.studentId, ...people(p.studentId) }))
    .sort((a, b) => a.studentName.localeCompare(b.studentName));
}
