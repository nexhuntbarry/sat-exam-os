// lib/teacher-qa.ts
//
// Per-test admin switch "Teachers can view & print questions/answers"
// (tests.teacher_qa_enabled, migration 0032). When off, teachers can't open
// the Questions & answers (Class Review) page or print the test; they still
// see results and scores. Admins are never blocked. A full-length SAT
// section follows its parent's switch. Separate from tests.review_unlocked
// (the students' class-review lock): neither affects the other.
//
// The only place that reads or writes the column. Until 0032 is applied the
// column doesn't exist: reads treat that as ON, writes report it so the API
// can answer 503 "database update pending".

import type { SupabaseClient } from "@supabase/supabase-js";
import { childrenOf, parentOf } from "@/lib/full-length";

type DbError = { code?: string; message?: string; status?: number } | null | undefined;

/** Pure: the error is "teacher_qa_enabled doesn't exist yet" (migration 0032 not applied). */
export function isTeacherQaColumnMissing(err: DbError): boolean {
  if (!err) return false;
  // Only when the error names this column: another missing column is a real bug.
  const msg = err.message ?? "";
  if (!/teacher_qa_enabled/.test(msg)) return false;
  return (
    err.code === "42703" ||
    err.code === "PGRST204" ||
    err.code === "400" ||
    err.status === 400 ||
    /does not exist|schema cache/.test(msg)
  );
}

export type TeacherQaDecision = "allow" | "no-access" | "off";

/**
 * Pure gate for the teacher Questions & answers page and teacher print.
 * no-access: not an admin or an approved teacher who can open the test
 * (getTeacherTestAccess) — the caller answers 404 / redirect.
 * off: an approved teacher with access, but the admin turned the switch off.
 */
export function decideTeacherQa(input: {
  role: string | null | undefined;
  /** Teachers must be "approved" (unset counts as not approved). */
  accountStatus: string | null | undefined;
  hasAccess: boolean;
  qaEnabled: boolean;
}): TeacherQaDecision {
  if (!input.hasAccess) return "no-access";
  if (input.role === "admin") return "allow";
  if (input.role !== "teacher") return "no-access";
  if (input.accountStatus !== "approved") return "no-access";
  return input.qaEnabled ? "allow" : "off";
}

/**
 * test id → switch value, for each of `testIds`. A full-length section
 * reads its parent's value; an unknown id reads true. A missing column
 * reads true; any other error throws (callers fail closed or catch).
 */
export async function readTeacherQaEnabled(db: SupabaseClient, testIds: Iterable<string>): Promise<Map<string, boolean>> {
  const ids = Array.from(new Set(testIds));
  const out = new Map<string, boolean>(ids.map((id) => [id, true]));
  if (ids.length === 0) return out;
  const parents = await parentOf(db, ids);
  const governing = (id: string) => parents.get(id) ?? id;
  const { data, error } = await db
    .from("tests")
    .select("id, teacher_qa_enabled")
    .in("id", Array.from(new Set(ids.map(governing))));
  if (error) {
    if (isTeacherQaColumnMissing(error)) return out;
    throw new Error(`teacher_qa_enabled lookup failed: ${error.message}`);
  }
  const value = new Map(
    ((data ?? []) as { id: string; teacher_qa_enabled: boolean | null }[]).map((r) => [r.id, r.teacher_qa_enabled !== false]),
  );
  for (const id of ids) out.set(id, value.get(governing(id)) ?? true);
  return out;
}

/**
 * For greying out Questions & answers buttons: the ids among `testIds` whose
 * switch is off, for a teacher viewer (empty for admins). A failed read
 * leaves the buttons enabled — the review page and print read it again and
 * fail closed.
 */
export async function teacherQaOffIds(
  db: SupabaseClient,
  user: { role: string | null | undefined },
  testIds: Iterable<string>,
): Promise<Set<string>> {
  if (user.role !== "teacher") return new Set();
  try {
    const enabled = await readTeacherQaEnabled(db, testIds);
    return new Set([...enabled].filter(([, on]) => !on).map(([id]) => id));
  } catch (e) {
    console.error("[teacher-qa] switch read failed:", e);
    return new Set();
  }
}

/**
 * True when `user` is a teacher and the switch is off for `testId` (a
 * full-length section: its parent's): their views must leave out question
 * content — text, choices, figures, the correct answer and explanations —
 * keeping numbers, domains, the student's answers, right/wrong and stats.
 * Admins and students: false (students follow their own answer settings).
 * Throws on a lookup error (callers fail closed).
 */
export async function teacherQaContentHidden(
  db: SupabaseClient,
  user: { role: string | null | undefined },
  testId: string,
): Promise<boolean> {
  if (user.role !== "teacher") return false;
  return (await readTeacherQaEnabled(db, [testId])).get(testId) === false;
}

/** Every column of `tests` that points at questions (directly or through a module). */
const QUESTION_REF_COLUMNS =
  "id, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id, question_ids, is_adaptive";

type QuestionRefRow = {
  id: string;
  module_id: string | null;
  module_2_id: string | null;
  module_1_id: string | null;
  module_2_easy_id: string | null;
  module_2_hard_id: string | null;
  question_ids: unknown;
  is_adaptive: boolean | null;
};

/** Questions of tests whose switch is off: `covers(q)` is true for any question such a test shows. */
export interface TeacherQaOffQuestions {
  /** Modules a switched-off test shows in full. */
  moduleIds: Set<string>;
  /** Questions a switched-off quiz (question_ids) picks from its modules. */
  questionIds: Set<string>;
  covers(q: { id: string; module_id: string | null }): boolean;
}

/**
 * Pure: what a set of switched-off tests shows, by the student question-set
 * rule (lib/student-exam scopeToStudentQuestionSet): a non-adaptive test with
 * question_ids shows only those questions; any other test its modules in full.
 */
export function teacherQaOffQuestionsFrom(rows: QuestionRefRow[]): TeacherQaOffQuestions {
  const moduleIds = new Set<string>();
  const questionIds = new Set<string>();
  for (const t of rows) {
    const picked = Array.isArray(t.question_ids) ? (t.question_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (!t.is_adaptive && picked.length > 0) {
      for (const id of picked) questionIds.add(id);
      continue;
    }
    for (const m of [t.module_id, t.module_2_id, t.module_1_id, t.module_2_easy_id, t.module_2_hard_id]) if (m) moduleIds.add(m);
  }
  return {
    moduleIds,
    questionIds,
    covers: (q) => questionIds.has(q.id) || (q.module_id != null && moduleIds.has(q.module_id)),
  };
}

/**
 * The questions a teacher must not get through other doors (Teaching Mode
 * question picker / quick test) because a test showing them has the switch
 * off. A full-length parent's switch covers its two sections. Two selects
 * (switched-off tests, then the sections of switched-off full-length
 * parents) plus the memoized full-length links. A missing column → nothing
 * is off; any other error throws (callers fail closed).
 */
export async function teacherQaOffQuestions(db: SupabaseClient): Promise<TeacherQaOffQuestions> {
  const { data, error } = await db.from("tests").select(QUESTION_REF_COLUMNS).eq("teacher_qa_enabled", false);
  if (error) {
    if (isTeacherQaColumnMissing(error)) return teacherQaOffQuestionsFrom([]);
    throw new Error(`teacher_qa_enabled lookup failed: ${error.message}`);
  }
  const off = (data ?? []) as unknown as QuestionRefRow[];
  const kids = await childrenOf(db, off.map((t) => t.id));
  const kidIds = [...kids.values()].flatMap((k) => [k.rw, k.math]).filter((x): x is string => Boolean(x));
  let sections: QuestionRefRow[] = [];
  if (kidIds.length > 0) {
    const { data: rows, error: kidError } = await db.from("tests").select(QUESTION_REF_COLUMNS).in("id", kidIds);
    if (kidError) throw new Error(`teacher_qa_enabled sections lookup failed: ${kidError.message}`);
    sections = (rows ?? []) as unknown as QuestionRefRow[];
  }
  return teacherQaOffQuestionsFrom([...off, ...sections]);
}

/** Set the switch on one test (a full-length parent, never a section). Throws on errors other than the missing column. */
export async function writeTeacherQaEnabled(
  db: SupabaseClient,
  testId: string,
  enabled: boolean,
): Promise<"ok" | "column-missing"> {
  const { error } = await db
    .from("tests")
    .update({ teacher_qa_enabled: enabled, updated_at: new Date().toISOString() })
    .eq("id", testId);
  if (!error) return "ok";
  if (isTeacherQaColumnMissing(error)) return "column-missing";
  throw new Error(`teacher_qa_enabled update failed: ${error.message}`);
}

/**
 * getTeacherTestAccess + the switch, for one test. `access` is the
 * getTeacherTestAccess result (scope queries with it as usual).
 */
export async function teacherQaGate(
  db: SupabaseClient,
  user: { userId: string; role: string | null | undefined; isQa: boolean; accountStatus: string | null | undefined },
  testId: string,
) {
  // Loaded lazily so the pure helpers above stay importable by unit tests
  // (teacher-access pulls in next/server through lib/qa).
  const { getTeacherTestAccess } = await import("@/lib/teacher-access");
  const access = await getTeacherTestAccess(db, user, testId);
  const qaEnabled =
    user.role === "teacher" && access.mode !== null ? (await readTeacherQaEnabled(db, [testId])).get(testId) ?? true : true;
  return { decision: decideTeacherQa({ ...user, hasAccess: access.mode !== null, qaEnabled }), access };
}
