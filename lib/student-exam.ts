// lib/student-exam.ts
//
// Single source of truth for the rules a student's exam is held to:
//   - which questions a student sees AND is graded on (Approved only),
//   - when a module's clock started (Module 2 starts when first opened),
//   - the per-module time limit and server-side deadline,
//   - whether a test is assigned to a student.
// The take page, the resume/autosave route, submit, the cron finalizer,
// admin force-submit and the result/review pages all go through these so
// what a student is shown and what they are graded on can never diverge.

import type { SupabaseClient } from "@supabase/supabase-js";

/** The only parsing_status a student ever sees or is graded on. */
export const STUDENT_VISIBLE_QUESTION_STATUS = "Approved";

// Loose structural view of a PostgREST filter builder (same approach as
// lib/qa.ts) so the helper works on any `.from("questions").select(...)`.
interface FilterLike {
  eq(column: string, value: unknown): FilterLike;
  in(column: string, values: readonly unknown[]): FilterLike;
}

export interface QuestionSetScope {
  is_adaptive?: boolean | null;
  question_ids?: string[] | null;
}

/**
 * Restrict a questions query to the student-visible set: Approved only,
 * plus the per-test question_ids subset on the legacy single-module path
 * (adaptive / two-module tests grade every question of the module).
 * The caller still applies the module filter and ordering.
 */
export function scopeToStudentQuestionSet<Q>(query: Q, test: QuestionSetScope): Q {
  let q = (query as unknown as FilterLike).eq(
    "parsing_status",
    STUDENT_VISIBLE_QUESTION_STATUS,
  );
  if (
    !test.is_adaptive &&
    Array.isArray(test.question_ids) &&
    test.question_ids.length > 0
  ) {
    q = q.in("id", test.question_ids);
  }
  return q as unknown as Q;
}

export function isModule2Track(track: string | null | undefined): boolean {
  return track === "module_2" || track === "module_2_easy" || track === "module_2_hard";
}

/** Grace on top of the module limit before autosave/submit count as late. */
export const DEADLINE_GRACE_SECONDS = 60;

export interface ModuleTiming {
  time_limit_minutes?: number | null;
  time_limit_minutes_module_2?: number | null;
  is_untimed?: boolean | null;
}

/**
 * Minutes allowed for this submission's module, or null when the test is
 * untimed / has no limit configured (no server-side enforcement then).
 */
export function moduleTimeLimitMinutes(
  test: ModuleTiming,
  track: string | null | undefined,
): number | null {
  if (test.is_untimed) return null;
  const limit = isModule2Track(track)
    ? test.time_limit_minutes_module_2 ?? test.time_limit_minutes
    : test.time_limit_minutes;
  return limit && limit > 0 ? limit : null;
}

export interface ModuleClockRow {
  started_at: string;
  adaptive_track: string | null;
  metadata?: unknown;
}

/**
 * When this module's clock started. Module 2 rows are created at the
 * Module 1 handoff but the timer only starts when the student first opens
 * the take page, which stamps metadata.module_2_started_at. Returns null
 * for a Module 2 that has never been opened.
 */
export function moduleStartedAtIso(sub: ModuleClockRow): string | null {
  if (!isModule2Track(sub.adaptive_track)) return sub.started_at;
  const meta = (sub.metadata ?? {}) as Record<string, unknown>;
  const stamp = meta.module_2_started_at;
  return typeof stamp === "string" && stamp ? stamp : null;
}

/**
 * Server-side deadline (epoch ms) for this module INCLUDING the grace,
 * or null when untimed. An unopened Module 2 is measured from now, i.e.
 * it has its full time ahead of it.
 */
export function moduleDeadlineMs(
  sub: ModuleClockRow,
  test: ModuleTiming,
  now = Date.now(),
): number | null {
  const limit = moduleTimeLimitMinutes(test, sub.adaptive_track);
  if (limit == null) return null;
  const startIso = moduleStartedAtIso(sub);
  const start = startIso ? new Date(startIso).getTime() : now;
  return start + limit * 60_000 + DEADLINE_GRACE_SECONDS * 1000;
}

/** Student's class group ids. */
async function studentClassGroupIds(db: SupabaseClient, studentId: string) {
  const { data: membership } = await db
    .from("class_group_members")
    .select("class_group_id")
    .eq("student_id", studentId);
  return (membership ?? []).map((m) => m.class_group_id as string);
}

function assignmentMatches(
  a: { student_ids: string[] | null; class_group_ids: string[] | null },
  studentId: string,
  classGroupIds: string[],
) {
  const sIds: string[] = a.student_ids ?? [];
  const cgIds: string[] = a.class_group_ids ?? [];
  return sIds.includes(studentId) || classGroupIds.some((cg) => cgIds.includes(cg));
}

/**
 * Every test id assigned to the student, directly (student_ids) or via
 * one of their class groups (class_group_ids). QA-side filtering is the
 * caller's job.
 */
export async function getAssignedTestIds(
  db: SupabaseClient,
  studentId: string,
): Promise<Set<string>> {
  const [classGroupIds, { data: allAssignments }] = await Promise.all([
    studentClassGroupIds(db, studentId),
    db.from("test_assignments").select("test_id, student_ids, class_group_ids"),
  ]);
  const ids = new Set<string>();
  for (const a of allAssignments ?? []) {
    if (assignmentMatches(a, studentId, classGroupIds)) ids.add(a.test_id);
  }
  return ids;
}

/** Is this one test assigned to the student? (Same rule as above.) */
export async function isTestAssignedToStudent(
  db: SupabaseClient,
  testId: string,
  studentId: string,
): Promise<boolean> {
  const [classGroupIds, { data: rows }] = await Promise.all([
    studentClassGroupIds(db, studentId),
    db
      .from("test_assignments")
      .select("test_id, student_ids, class_group_ids")
      .eq("test_id", testId),
  ]);
  return (rows ?? []).some((a) => assignmentMatches(a, studentId, classGroupIds));
}

/**
 * Overlay an answer patch on the saved answers. A null / empty value
 * clears that question. Non-string values are ignored and answers are
 * length-capped so a manual request can't store multi-KB blobs.
 */
export function mergeAnswers(
  saved: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = { ...saved };
  for (const [qid, value] of Object.entries(patch)) {
    if (value == null || value === "") delete out[qid];
    else if (typeof value === "string") out[qid] = value.slice(0, 64);
  }
  return out;
}

// metadata keys only the server may write: the Module 2 clock and the
// optimistic-concurrency version for answers.
const SERVER_OWNED_METADATA_KEYS = ["module_2_started_at", "answers_version"];

/** Drop server-owned keys from client-supplied metadata. */
export function sanitizeClientMetadata(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...meta };
  for (const k of SERVER_OWNED_METADATA_KEYS) delete out[k];
  return out;
}

/**
 * Start an unstamped Module 2's clock at server now(). Same guarded write
 * the take page uses: bumps metadata.answers_version and only lands if
 * the version is unchanged, so a concurrent autosave can't drop the
 * stamp. Returns the row's metadata afterwards (re-read if we lost a race
 * — a parallel request may have stamped first). Never takes a
 * client-supplied time.
 */
export async function stampModule2Start(
  db: SupabaseClient,
  submissionId: string,
  metadata: unknown,
): Promise<Record<string, unknown>> {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.module_2_started_at === "string" && meta.module_2_started_at) return meta;
  const version = typeof meta.answers_version === "number" ? meta.answers_version : 0;
  const next = {
    ...meta,
    module_2_started_at: new Date().toISOString(),
    answers_version: version + 1,
  };
  let q = db
    .from("submissions")
    .update({ metadata: next })
    .eq("id", submissionId)
    .eq("status", "In Progress");
  q = version === 0
    ? q.is("metadata->answers_version", null)
    : q.eq("metadata->answers_version", version);
  const { data: written } = await q.select("id");
  if (written && written.length > 0) return next;
  const { data: fresh } = await db
    .from("submissions")
    .select("metadata")
    .eq("id", submissionId)
    .maybeSingle();
  return (fresh?.metadata ?? meta) as Record<string, unknown>;
}
