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
import { asParentRows, closedFullLengthAttemptKeys, fullLengthLinksOrNone, resolveParentTestId } from "@/lib/full-length";

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
 * Server-owned submission metadata keys of a full-length SAT attempt
 * (lib/full-length.ts). Section tests never carry them.
 *   time_multiplier — extended time (1.25 / 1.5 / 2), applied to every module
 *   fl_attempt_id   — full_length_attempts.id
 *   fl_started_at   — when the whole full-length attempt started (Late rule)
 */
export const FULL_LENGTH_METADATA_KEYS = ["time_multiplier", "fl_attempt_id", "fl_started_at"] as const;

/**
 * Extended-time multiplier stamped on a submission (metadata.time_multiplier),
 * or 1 when absent / not a sane number. Only full-length attempts carry it.
 */
export function timeMultiplier(metadata?: unknown): number {
  const m = (metadata as Record<string, unknown> | null | undefined)?.time_multiplier;
  return typeof m === "number" && Number.isFinite(m) && m >= 1 && m <= 3 ? m : 1;
}

/**
 * Minutes allowed for this submission's module, or null when the test is
 * untimed / has no limit configured (no server-side enforcement then).
 * Pass the submission's metadata to apply its extended-time multiplier;
 * without one the result is the configured limit, unchanged. May be
 * fractional with a multiplier (×1.5 of 35 = 52.5).
 */
export function moduleTimeLimitMinutes(
  test: ModuleTiming,
  track: string | null | undefined,
  metadata?: unknown,
): number | null {
  if (test.is_untimed) return null;
  const limit = isModule2Track(track)
    ? test.time_limit_minutes_module_2 ?? test.time_limit_minutes
    : test.time_limit_minutes;
  if (!(limit && limit > 0)) return null;
  const mult = timeMultiplier(metadata);
  return mult === 1 ? limit : limit * mult;
}

/** moduleTimeLimitMinutes in whole seconds (fractional minutes rounded). */
export function moduleTimeLimitSeconds(
  test: ModuleTiming,
  track: string | null | undefined,
  metadata?: unknown,
): number | null {
  const limit = moduleTimeLimitMinutes(test, track, metadata);
  return limit == null ? null : Math.round(limit * 60);
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
  const limitSeconds = moduleTimeLimitSeconds(test, sub.adaptive_track, sub.metadata);
  if (limitSeconds == null) return null;
  const startIso = moduleStartedAtIso(sub);
  const start = startIso ? new Date(startIso).getTime() : now;
  return start + limitSeconds * 1000 + DEADLINE_GRACE_SECONDS * 1000;
}

/**
 * Seconds left on this module's clock (no grace), or null when untimed.
 * Read from the test's current limit, so an admin adding time mid-exam
 * shows up here; the take page re-syncs its timer from it.
 */
export function moduleRemainingSeconds(
  sub: ModuleClockRow,
  test: ModuleTiming,
  now = Date.now(),
): number | null {
  const limitSeconds = moduleTimeLimitSeconds(test, sub.adaptive_track, sub.metadata);
  if (limitSeconds == null) return null;
  const startIso = moduleStartedAtIso(sub);
  if (!startIso) return limitSeconds;
  return Math.max(0, Math.floor((new Date(startIso).getTime() + limitSeconds * 1000 - now) / 1000));
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

/** How one test reaches a student. */
export interface StudentAssignment {
  testId: string;
  /** Listed in test_assignments.student_ids. */
  direct: boolean;
  /** The student's class groups listed in class_group_ids. */
  classGroupIds: string[];
  /** test_assignments.created_at (earliest row for the test). */
  assignedAt: string | null;
}

/**
 * Every test assigned to the student, directly (student_ids) or via one
 * of their class groups (class_group_ids), with how it was assigned.
 * QA-side filtering is the caller's job.
 */
export async function getStudentAssignments(
  db: SupabaseClient,
  studentId: string,
): Promise<Map<string, StudentAssignment>> {
  const [classGroupIds, { data: allAssignments, error }] = await Promise.all([
    studentClassGroupIds(db, studentId),
    db.from("test_assignments").select("test_id, student_ids, class_group_ids, created_at"),
  ]);
  if (error) throw new Error(`test_assignments lookup failed: ${error.message}`);
  const out = new Map<string, StudentAssignment>();
  for (const a of allAssignments ?? []) {
    if (!assignmentMatches(a, studentId, classGroupIds)) continue;
    const testId = a.test_id as string;
    const cur = out.get(testId) ?? { testId, direct: false, classGroupIds: [], assignedAt: null };
    cur.direct ||= ((a.student_ids as string[] | null) ?? []).includes(studentId);
    const cg = (a.class_group_ids as string[] | null) ?? [];
    for (const g of classGroupIds) if (cg.includes(g) && !cur.classGroupIds.includes(g)) cur.classGroupIds.push(g);
    const created = (a.created_at as string | null) ?? null;
    if (created && (!cur.assignedAt || created < cur.assignedAt)) cur.assignedAt = created;
    out.set(testId, cur);
  }
  return out;
}

/** Every test id assigned to the student (see getStudentAssignments). */
export async function getAssignedTestIds(
  db: SupabaseClient,
  studentId: string,
): Promise<Set<string>> {
  return new Set((await getStudentAssignments(db, studentId)).keys());
}

/**
 * Test IDs for which the student has an unfinished attempt even if no longer
 * assigned: either any In Progress submission, or a graded Module 1 whose
 * Module 2 row hasn't been created yet (the M1→M2 handoff case).
 * Full-length SAT rows are reported under the parent id; an attempt whose
 * Math isn't finished (on the break included) counts as unfinished.
 * These should appear in the student's test list marked "finish your attempt"
 * and must be accessible via the student test landing page.
 */
export async function getInProgressOrPendingM2TestIds(
  db: SupabaseClient,
  studentId: string,
): Promise<Set<string>> {
  const { data: rawSubs } = await db
    .from("submissions")
    .select("test_id, student_id, status, adaptive_track, attempt_number")
    .eq("student_id", studentId)
    .in("status", ["In Progress", "Submitted", "Late"])
    .order("attempt_number", { ascending: false });

  if (!rawSubs || rawSubs.length === 0) return new Set();
  const flLinks = await fullLengthLinksOrNone(db);
  const subs = asParentRows(
    rawSubs as { test_id: string; student_id: string; status: string; adaptive_track: string | null; attempt_number: number | null }[],
    flLinks,
    await closedFullLengthAttemptKeys(db, flLinks, studentId),
  );

  // Group by (test_id, latest attempt_number)
  const latestByTest = new Map<string, { attempt: number; rows: { status: string; adaptive_track: string | null }[] }>();
  for (const s of subs) {
    const tid = s.test_id as string;
    const att = (s.attempt_number as number) ?? 1;
    const cur = latestByTest.get(tid);
    if (!cur || att > cur.attempt) {
      latestByTest.set(tid, { attempt: att, rows: [] });
    }
    if (latestByTest.get(tid)!.attempt === att) {
      latestByTest.get(tid)!.rows.push({
        status: s.status as string,
        adaptive_track: s.adaptive_track as string | null,
      });
    }
  }

  const result = new Set<string>();
  for (const [testId, { rows }] of latestByTest) {
    // Case 1: any module is In Progress
    if (rows.some((r) => r.status === "In Progress")) {
      result.add(testId);
      continue;
    }
    // Case 2: graded M1 with no M2 yet (needsModule2 / handoff pending)
    const hasGradedM1 = rows.some(
      (r) => r.adaptive_track === "module_1" && (r.status === "Submitted" || r.status === "Late"),
    );
    const hasM2 = rows.some((r) => r.adaptive_track && r.adaptive_track !== "module_1");
    if (hasGradedM1 && !hasM2) result.add(testId);
  }
  return result;
}

/**
 * Is this one test assigned to the student? (Same rule as above.) A
 * full-length section child is assigned when its parent is.
 */
export async function isTestAssignedToStudent(
  db: SupabaseClient,
  testId: string,
  studentId: string,
): Promise<boolean> {
  const assignmentsOf = (id: string) =>
    db.from("test_assignments").select("test_id, student_ids, class_group_ids").eq("test_id", id);
  const [classGroupIds, assignmentTestId, { data: ownRows }] = await Promise.all([
    studentClassGroupIds(db, studentId),
    resolveParentTestId(db, testId),
    assignmentsOf(testId),
  ]);
  const rows = assignmentTestId === testId ? ownRows : (await assignmentsOf(assignmentTestId)).data;
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
/** One question's flag / crossed-out choices / highlights, as the take page sends them. */
export interface QuestionMetaPatch {
  flagged: boolean;
  crossed: string[];
  annos: Record<string, unknown> | null;
}

/**
 * Apply per-question flag / cross-out / highlight changes onto the saved
 * metadata. The take page used to send these whole, so a laptop that came
 * back online after the student moved to another computer wrote its old
 * flags and cross-outs back over the new ones (D-20261104-1). Now only
 * questions changed on that device are sent, and only those are replaced.
 */
export function applyQuestionMeta(
  saved: Record<string, unknown>,
  patch: Record<string, unknown>,
): Pick<Record<string, unknown>, "flagged" | "crossed_out" | "annotations"> {
  const flagged = new Set(Array.isArray(saved.flagged) ? (saved.flagged as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const crossed: Record<string, unknown> =
    saved.crossed_out && typeof saved.crossed_out === "object" ? { ...(saved.crossed_out as Record<string, unknown>) } : {};
  const annos: Record<string, unknown> =
    saved.annotations && typeof saved.annotations === "object" ? { ...(saved.annotations as Record<string, unknown>) } : {};
  for (const [qid, raw] of Object.entries(patch).slice(0, 500)) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Partial<QuestionMetaPatch>;
    if (p.flagged) flagged.add(qid);
    else flagged.delete(qid);
    const labels = Array.isArray(p.crossed) ? p.crossed.filter((l): l is string => typeof l === "string").slice(0, 10) : [];
    if (labels.length) crossed[qid] = labels;
    else delete crossed[qid];
    if (p.annos && typeof p.annos === "object" && Object.keys(p.annos).length) annos[qid] = p.annos;
    else delete annos[qid];
  }
  return { flagged: [...flagged], crossed_out: crossed, annotations: annos };
}

const SERVER_OWNED_METADATA_KEYS = [
  "module_2_started_at",
  "answers_version",
  "device",
  // Set by lib/module2-handoff recovery after the due date; makes it Late.
  "created_after_due",
  "auto_closed_unopened",
  // Full-length SAT attempt (extended time, attempt link, attempt start).
  ...FULL_LENGTH_METADATA_KEYS,
];

/**
 * Metadata an admin reset keeps. A section test's row gets {} as always.
 * A full-length row (one carrying any full-length key) keeps those keys,
 * so the reset module keeps its extended time and attempt link, plus the
 * device, for support.
 */
export function resetSubmissionMetadata(old: unknown): Record<string, unknown> {
  const meta = (old && typeof old === "object" ? old : {}) as Record<string, unknown>;
  if (!FULL_LENGTH_METADATA_KEYS.some((k) => meta[k] !== undefined)) return {};
  const out: Record<string, unknown> = {};
  for (const k of [...FULL_LENGTH_METADATA_KEYS, "device"]) {
    if (meta[k] !== undefined) out[k] = meta[k];
  }
  return out;
}

/** metadata.fl_started_at as epoch ms, or null (section tests). */
export function fullLengthStartedAtMs(metadata: unknown): number | null {
  const v = (metadata as Record<string, unknown> | null | undefined)?.fl_started_at;
  if (typeof v !== "string" || !v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Device a module was started on (submissions.metadata.device). */
export interface DeviceInfo {
  /** Raw user agent, capped. */
  ua: string;
  /** Rough label: iPhone, iPad, Android, Windows, Mac, ChromeOS, Linux or Other. */
  platform: string;
  at: string;
}

/**
 * Device info from the request headers, for support ("which device was
 * the student on?"). Prefers the Sec-CH-UA-Platform client hint when the
 * browser sends one. iPadOS Safari reports itself as a Mac.
 */
export function deviceInfoFromHeaders(headers: Headers): DeviceInfo | null {
  const ua = headers.get("user-agent") ?? "";
  if (!ua) return null;
  const hint = (headers.get("sec-ch-ua-platform") ?? "").replace(/"/g, "");
  let platform = "Other";
  if (/iPhone|iPod/.test(ua)) platform = "iPhone";
  else if (/iPad/.test(ua)) platform = "iPad";
  else if (/Android/.test(ua)) platform = "Android";
  else if (/CrOS/.test(ua) || hint === "Chrome OS") platform = "ChromeOS";
  else if (/Windows/.test(ua) || hint === "Windows") platform = "Windows";
  else if (/Macintosh|Mac OS X/.test(ua) || hint === "macOS") platform = "Mac";
  else if (/Linux/.test(ua) || hint === "Linux") platform = "Linux";
  return { ua: ua.slice(0, 300), platform, at: new Date().toISOString() };
}

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
