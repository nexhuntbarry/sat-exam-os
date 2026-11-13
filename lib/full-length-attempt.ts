// lib/full-length-attempt.ts
//
// Full-length SAT, Phase 2 (plan: .omc/plans/full-length-sat.md, section 4):
// the student runtime of one full-length attempt.
//
//   R&W Module 1 → R&W Module 2 → break → Math Module 1 → Math Module 2 → done
//
// Each section runs on its hidden fl_section child with the ordinary
// per-module machinery (take client, autosave, submit, Module 2 handoff,
// cron). This file only orchestrates: it derives where an attempt is from
// its submission rows (flState, pure and unit-tested), starts an attempt
// (R&W Module 1), starts Math after the break, recovers the gaps a crash
// can leave, and closes attempts whose Math can no longer be started (cron).
//
// Every write is insert-first and adopts the existing row on 23505, so a
// double click, two tabs or two devices end up on the same rows. The
// submission rows are the source of truth; full_length_attempts.math_session_id
// is only a link, reconciled when it lags.
//
// Kept free of next/* so the unit tests can load it.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isModule2Track,
  moduleStartedAtIso,
  type DeviceInfo,
} from "@/lib/student-exam";
import {
  HANDOFF_TEST_COLUMNS,
  MODULE_2_LATE_RECOVERY_HOURS,
  module2RecoveryBlock,
  recoverModule2,
  type HandoffTest,
  type Module2Block,
} from "@/lib/module2-handoff";
import { loadTimeMultiplier } from "@/lib/full-length-admin";
import { dropUnansweredSubmission, testIsDraftNow } from "@/lib/draft-race";

// ------------------------------------------------------------ constants

/**
 * After the due date, Math may still be started this long after R&W
 * Module 2 was graded (the one window: same as a late Module 2).
 */
export const FL_LATE_START_WINDOW_HOURS = MODULE_2_LATE_RECOVERY_HOURS;

/** The break screen's auto start at 0:00 is accepted this early (clock skew). */
export const FL_AUTO_START_TOLERANCE_MS = 2000;

/** Default break when a snapshot is missing (SAT: 10 minutes). */
const DEFAULT_BREAK_MINUTES = 10;

// ---------------------------------------------------------------- types

export interface FlAttempt {
  id: string;
  test_id: string;
  student_id: string;
  attempt_number: number;
  rw_session_id: string;
  math_session_id: string | null;
  time_multiplier: number | string | null;
  break_minutes: number | null;
  allow_section_pause: boolean | null;
  started_at: string;
  closed_at: string | null;
  closed_reason: string | null;
}
export const FL_ATTEMPT_COLUMNS =
  "id, test_id, student_id, attempt_number, rw_session_id, math_session_id, time_multiplier, " +
  "break_minutes, allow_section_pause, started_at, closed_at, closed_reason";

/** A submission row on one of the two children. */
export interface FlRow {
  id: string;
  test_id: string;
  student_id?: string;
  status: string;
  adaptive_track: string | null;
  attempt_number: number | null;
  session_id: string | null;
  started_at: string;
  submitted_at: string | null;
  metadata: unknown;
  module_id?: string | null;
  percentage?: number | string | null;
}
export const FL_ROW_COLUMNS =
  "id, test_id, student_id, status, adaptive_track, attempt_number, session_id, started_at, submitted_at, metadata, module_id, percentage";

export interface FlParent {
  id: string;
  test_name: string;
  status: string | null;
  open_date: string | null;
  due_date: string | null;
  allow_retake: boolean | null;
  break_minutes: number | null;
  allow_section_pause: boolean | null;
  test_kind: string | null;
}
export const FL_PARENT_COLUMNS =
  "id, test_name, status, open_date, due_date, allow_retake, break_minutes, allow_section_pause, test_kind";

export interface FlChildTest extends HandoffTest {
  id: string;
  test_name: string;
  section_order: number | null;
  status: string | null;
  due_date: string | null;
  module_id: string | null;
  module_1_id: string | null;
  time_limit_minutes: number | null;
  time_limit_minutes_module_2: number | null;
  is_untimed: boolean | null;
  question_ids: string[] | null;
  desmos_enabled: boolean | null;
  formula_sheet_url: string | null;
}
export const FL_CHILD_COLUMNS =
  "id, test_name, section_order, status, due_date, module_id, module_1_id, time_limit_minutes, " +
  `time_limit_minutes_module_2, is_untimed, question_ids, desmos_enabled, formula_sheet_url, ${HANDOFF_TEST_COLUMNS}`;

export interface FlContext {
  parent: FlParent;
  rw: FlChildTest;
  math: FlChildTest;
}

export type FlSection = "rw" | "math";

export type FlStateName =
  | "rw_missing"
  | "rw_m1"
  | "rw_handoff"
  | "rw_m2_intro"
  | "rw_m2"
  | "break"
  | "math_m1"
  | "math_handoff"
  | "math_m2_intro"
  | "math_m2"
  | "done"
  | "closed";

/** Why Math may not be started now (only meaningful on the break). */
export type MathStartBlock = "closed" | "window_passed";

export interface FlState {
  state: FlStateName;
  /** Section the student is in (null when done / closed). */
  section: FlSection | null;
  /**
   * The row this state is about: the In Progress module for *_m1 / *_m2 /
   * *_m2_intro, the graded Module 1 for *_handoff, R&W Module 2 on the break.
   */
  row: FlRow | null;
  /** Break only: when it ends (epoch ms). */
  breakEndsAtMs: number | null;
  /** Break only: whole seconds left (0 once over). */
  breakRemainingSeconds: number | null;
  /** Break only: why Math may not start now, or null. */
  mathStartBlock: MathStartBlock | null;
  /** The Math Module 1 row's session, when math_session_id still has to be linked. */
  unlinkedMathSessionId: string | null;
}

// ----------------------------------------------------------- pure state

// Graded = claimed (status) AND finished grading (submitted_at). A row
// whose submit is still grading counts as not graded yet, so nothing moves
// on (or recovers a "missing" Module 2) mid-grading.
const isGraded = (r: FlRow) => r.status !== "In Progress" && Boolean(r.submitted_at);

function moduleRows(rows: FlRow[], testId: string, attemptNumber: number) {
  const mine = rows
    .filter((r) => r.test_id === testId && (r.attempt_number ?? 1) === attemptNumber)
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
  return {
    m1: mine.find((r) => r.adaptive_track === "module_1") ?? null,
    m2: mine.find((r) => isModule2Track(r.adaptive_track)) ?? null,
  };
}

/** The break's end (epoch ms): R&W Module 2 graded + break minutes. No extended time on the break. */
export function breakEndsAtMs(attempt: Pick<FlAttempt, "break_minutes" | "started_at">, rwM2: Pick<FlRow, "submitted_at" | "started_at">): number {
  const from = Date.parse(rwM2.submitted_at ?? rwM2.started_at ?? attempt.started_at);
  const minutes = attempt.break_minutes ?? DEFAULT_BREAK_MINUTES;
  return from + Math.max(0, minutes) * 60_000;
}

/**
 * May Math be started now? One rule for both pausing settings: the attempt
 * isn't closed, and either the due date hasn't passed or R&W Module 2 was
 * graded at most FL_LATE_START_WINDOW_HOURS ago. (Test status is checked
 * by the caller: Published or Closed both allow an existing attempt.)
 */
export function mathStartBlock(
  attempt: Pick<FlAttempt, "closed_at">,
  rwM2SubmittedAt: string | null,
  dueDate: string | null,
  now: number,
): MathStartBlock | null {
  if (attempt.closed_at) return "closed";
  if (dueDate && Date.parse(dueDate) < now) {
    const graded = rwM2SubmittedAt ? Date.parse(rwM2SubmittedAt) : NaN;
    if (!(now - graded <= FL_LATE_START_WINDOW_HOURS * 3_600_000)) return "window_passed";
  }
  return null;
}

/** Is an automatic start (break screen at 0:00) early by more than the tolerance? */
export function autoStartTooEarly(breakEnds: number, now: number): boolean {
  return now < breakEnds - FL_AUTO_START_TOLERANCE_MS;
}

/**
 * Where this attempt is. `rows` are the student's rows on the two children
 * (any attempt; only this attempt's number is used). Math rows are found by
 * (Math child, attempt_number), so an attempt whose math_session_id was
 * never linked still reads correctly.
 */
export function flState(
  attempt: FlAttempt,
  rows: FlRow[],
  children: { rw: string; math: string },
  parent: { due_date: string | null },
  now = Date.now(),
): FlState {
  const n = attempt.attempt_number;
  const rw = moduleRows(rows, children.rw, n);
  const math = moduleRows(rows, children.math, n);
  const base: FlState = {
    state: "done",
    section: null,
    row: null,
    breakEndsAtMs: null,
    breakRemainingSeconds: null,
    mathStartBlock: null,
    unlinkedMathSessionId:
      math.m1?.session_id && attempt.math_session_id !== math.m1.session_id ? math.m1.session_id : null,
  };

  if (math.m2 && isGraded(math.m2)) return { ...base, state: "done" };
  // A 'math_not_started' close that lost a race with a Math start (the row
  // exists) doesn't stop the student; any other close does.
  if (attempt.closed_at && (attempt.closed_reason !== "math_not_started" || !math.m1)) {
    return { ...base, state: "closed" };
  }

  // Where the student is inside a section whose Module 1 exists, or null
  // once both of its modules are graded.
  const inSection = (s: FlSection, m1: FlRow, m2: FlRow | null): FlState | null => {
    if (!isGraded(m1)) return { ...base, state: `${s}_m1`, section: s, row: m1 };
    if (!m2) return { ...base, state: `${s}_handoff`, section: s, row: m1 };
    if (isGraded(m2)) return null;
    const opened = moduleStartedAtIso(m2) != null;
    return { ...base, state: opened ? `${s}_m2` : `${s}_m2_intro`, section: s, row: m2 };
  };

  if (!rw.m1) return { ...base, state: "rw_missing", section: "rw" };
  const inRw = inSection("rw", rw.m1, rw.m2);
  if (inRw) return inRw;

  // R&W finished.
  if (!math.m1) {
    const rwM2 = rw.m2!;
    const ends = breakEndsAtMs(attempt, rwM2);
    return {
      ...base,
      state: "break",
      section: "math",
      row: rwM2,
      breakEndsAtMs: ends,
      breakRemainingSeconds: Math.max(0, Math.ceil((ends - now) / 1000)),
      mathStartBlock: mathStartBlock(attempt, rwM2.submitted_at, parent.due_date, now),
    };
  }
  const inMath = inSection("math", math.m1, math.m2);
  if (inMath) return inMath;
  return { ...base, state: "done" };
}

/** Finished for good (no more work possible on this attempt). */
export function flAttemptFinished(s: FlStateName): boolean {
  return s === "done" || s === "closed";
}

/** The full-length keys stamped into each module's metadata (plus the device). */
export function flModuleMetadata(
  attempt: Pick<FlAttempt, "id" | "time_multiplier" | "started_at">,
  device?: DeviceInfo | null,
): Record<string, unknown> {
  const mult = Number(attempt.time_multiplier ?? 1);
  return {
    time_multiplier: Number.isFinite(mult) && mult >= 1 ? mult : 1,
    fl_attempt_id: attempt.id,
    fl_started_at: attempt.started_at,
    ...(device ? { device } : {}),
  };
}

/** "52 min 30 s", "48 min", "45 s". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${rest} s`;
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}

/** "6:12" style countdown. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Student-facing label of where an attempt is ("Section 1 · Module 2", "On break · 6:12 left"). */
export function flStateLabel(st: FlState): string {
  switch (st.state) {
    case "rw_missing":
    case "rw_m1":
      return "Section 1 (Reading and Writing) · Module 1";
    case "rw_handoff":
    case "rw_m2_intro":
    case "rw_m2":
      return "Section 1 (Reading and Writing) · Module 2";
    case "break":
      return st.breakRemainingSeconds && st.breakRemainingSeconds > 0
        ? `On break · ${formatClock(st.breakRemainingSeconds)} left`
        : "Break over · Math not started yet";
    case "math_m1":
      return "Section 2 (Math) · Module 1";
    case "math_handoff":
    case "math_m2_intro":
    case "math_m2":
      return "Section 2 (Math) · Module 2";
    case "done":
      return "Finished";
    case "closed":
      return "Closed";
  }
}

/** Module 1 of a child (adaptive: module_1_id; fixed: module_id). */
export function childModule1Id(child: Pick<FlChildTest, "is_adaptive" | "module_1_id" | "module_id">): string | null {
  return (child.is_adaptive ? child.module_1_id : child.module_id) ?? null;
}

// --------------------------------------------------------------- reads

const fresh = () => new AbortController().signal;

/** Parent + both children, or null when `parentId` isn't a complete full-length test. */
export async function loadFlContext(db: SupabaseClient, parentId: string): Promise<FlContext | null> {
  const { data: parent, error } = await db
    .from("tests")
    .select(FL_PARENT_COLUMNS)
    .eq("id", parentId)
    .maybeSingle();
  if (error) throw new Error(`full-length test lookup: ${error.message}`);
  const p = parent as unknown as FlParent | null;
  if (!p || p.test_kind !== "full_length") return null;
  const { data: kids, error: kidsError } = await db
    .from("tests")
    .select(FL_CHILD_COLUMNS)
    .eq("parent_test_id", parentId);
  if (kidsError) throw new Error(`full-length sections lookup: ${kidsError.message}`);
  const rows = (kids ?? []) as unknown as FlChildTest[];
  const rw = rows.find((r) => r.section_order === 1);
  const math = rows.find((r) => r.section_order === 2);
  if (!rw || !math) return null;
  return { parent: p, rw, math };
}

/** The student's latest attempt on this full-length test, or null. */
export async function latestFlAttempt(db: SupabaseClient, parentId: string, studentId: string): Promise<FlAttempt | null> {
  const { data, error } = await db
    .from("full_length_attempts")
    .select(FL_ATTEMPT_COLUMNS)
    .eq("test_id", parentId)
    .eq("student_id", studentId)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .abortSignal(fresh())
    .maybeSingle();
  if (error) throw new Error(`full-length attempt lookup: ${error.message}`);
  return (data as unknown as FlAttempt | null) ?? null;
}

async function attemptByNumber(db: SupabaseClient, parentId: string, studentId: string, n: number) {
  const { data, error } = await db
    .from("full_length_attempts")
    .select(FL_ATTEMPT_COLUMNS)
    .eq("test_id", parentId)
    .eq("student_id", studentId)
    .eq("attempt_number", n)
    .abortSignal(fresh())
    .maybeSingle();
  if (error) throw new Error(`full-length attempt lookup: ${error.message}`);
  return (data as unknown as FlAttempt | null) ?? null;
}

/** This attempt's rows on both children (fresh read, never memoized). */
export async function flAttemptRows(
  db: SupabaseClient,
  ctx: { rw: { id: string }; math: { id: string } },
  studentId: string,
  attemptNumber: number,
): Promise<FlRow[]> {
  const { data, error } = await db
    .from("submissions")
    .select(FL_ROW_COLUMNS)
    .in("test_id", [ctx.rw.id, ctx.math.id])
    .eq("student_id", studentId)
    .eq("attempt_number", attemptNumber)
    .abortSignal(fresh());
  if (error) throw new Error(`full-length rows lookup: ${error.message}`);
  return (data ?? []) as unknown as FlRow[];
}

export function stateOf(ctx: FlContext, attempt: FlAttempt, rows: FlRow[], now = Date.now()): FlState {
  return flState(attempt, rows, { rw: ctx.rw.id, math: ctx.math.id }, ctx.parent, now);
}

// -------------------------------------------------------------- writes

/** Insert Module 1 of a section; on 23505 adopt the existing row. */
async function ensureModule1(
  db: SupabaseClient,
  child: FlChildTest,
  attempt: FlAttempt,
  sessionId: string,
  device: DeviceInfo | null | undefined,
): Promise<{ id: string; session_id: string; created: boolean }> {
  const moduleId = childModule1Id(child);
  if (!moduleId) throw new Error(`full-length section ${child.id} has no Module 1`);
  const { data, error } = await db
    .from("submissions")
    .insert({
      test_id: child.id,
      student_id: attempt.student_id,
      answers: {},
      status: "In Progress",
      started_at: new Date().toISOString(),
      attempt_number: attempt.attempt_number,
      metadata: flModuleMetadata(attempt, device),
      session_id: sessionId,
      module_id: moduleId,
      adaptive_track: "module_1",
    })
    .select("id, session_id")
    .single();
  if (!error && data) return { id: data.id as string, session_id: data.session_id as string, created: true };
  if (error?.code === "23505") {
    const { data: winner } = await db
      .from("submissions")
      .select("id, session_id")
      .eq("test_id", child.id)
      .eq("student_id", attempt.student_id)
      .eq("attempt_number", attempt.attempt_number)
      .eq("adaptive_track", "module_1")
      .abortSignal(fresh())
      .maybeSingle();
    if (winner) return { id: winner.id as string, session_id: winner.session_id as string, created: false };
  }
  throw new Error(`full-length module 1 insert: ${error?.message ?? "no row returned"}`);
}

/** R&W Module 1 of this attempt (the rw_missing recovery and the normal start). */
export function ensureRwModule1(db: SupabaseClient, ctx: FlContext, attempt: FlAttempt, device?: DeviceInfo | null) {
  return ensureModule1(db, ctx.rw, attempt, attempt.rw_session_id, device);
}

/**
 * Math Module 1 exists: a cron 'math_not_started' close that raced the
 * Math start no longer applies. Other closes are left alone.
 */
async function clearMathNotStartedClose(db: SupabaseClient, attemptId: string) {
  const { error } = await db
    .from("full_length_attempts")
    .update({ closed_at: null, closed_reason: null })
    .eq("id", attemptId)
    .eq("closed_reason", "math_not_started");
  if (error) console.error("[full-length] clear math_not_started close", attemptId, error.message);
}

/** Link the Math session on the attempt (only while unlinked). */
async function linkMathSession(db: SupabaseClient, attemptId: string, sessionId: string) {
  const { error } = await db
    .from("full_length_attempts")
    .update({ math_session_id: sessionId })
    .eq("id", attemptId)
    .is("math_session_id", null);
  if (error) console.error("[full-length/start-math] link math session", attemptId, error.message);
}

export type StartResult =
  | { ok: true; attempt: FlAttempt; resumed: boolean; submissionId: string | null }
  | { ok: false; status: number; error: string };

/**
 * Start (or resume) the student's full-length attempt. Resumes the latest
 * attempt that can still continue; otherwise creates attempt max+1 (needs
 * Published, assigned, open, not past due, retake allowed), adopting a
 * concurrent creator's row on 23505, then makes sure R&W Module 1 exists.
 * The caller has checked studentTestAccess(parent) and passes `assigned`.
 */
export async function startFlAttempt(
  db: SupabaseClient,
  ctx: FlContext,
  studentId: string,
  opts: { assigned: boolean; device?: DeviceInfo | null; now?: number },
): Promise<StartResult> {
  const now = opts.now ?? Date.now();
  const { parent } = ctx;
  const latest = await latestFlAttempt(db, parent.id, studentId);
  if (latest) {
    const st = stateOf(ctx, latest, await flAttemptRows(db, ctx, studentId, latest.attempt_number), now);
    if (!flAttemptFinished(st.state)) {
      let submissionId = st.row?.id ?? null;
      if (st.state === "rw_missing") submissionId = (await ensureRwModule1(db, ctx, latest, opts.device)).id;
      return { ok: true, attempt: latest, resumed: true, submissionId };
    }
  }

  // A new attempt.
  if (parent.status !== "Published") return { ok: false, status: 403, error: "Test is not available" };
  if (!opts.assigned) return { ok: false, status: 403, error: "Test is not assigned to you" };
  if (parent.open_date && Date.parse(parent.open_date) > now) {
    return { ok: false, status: 403, error: "Test is not open yet" };
  }
  if (parent.due_date && Date.parse(parent.due_date) < now) {
    return { ok: false, status: 403, error: "Test due date has passed" };
  }
  if (!childModule1Id(ctx.rw) || !childModule1Id(ctx.math)) {
    return { ok: false, status: 400, error: "This full-length test is missing a module" };
  }

  // Prior attempts: the attempt rows, and (defensively) the children's
  // submissions, whose attempt numbers must stay unique per track.
  const { data: priorRow, error: priorError } = await db
    .from("submissions")
    .select("attempt_number")
    .in("test_id", [ctx.rw.id, ctx.math.id])
    .eq("student_id", studentId)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (priorError) throw new Error(`full-length prior attempt lookup: ${priorError.message}`);
  const prior = Math.max(latest?.attempt_number ?? 0, (priorRow?.attempt_number as number | undefined) ?? 0);

  let grantId: string | null = null;
  if (prior > 0) {
    const { data: grant, error: grantError } = await db
      .from("test_retake_grants")
      .select("id")
      .eq("test_id", parent.id)
      .eq("student_id", studentId)
      .is("consumed_at", null)
      .order("granted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (grantError) throw new Error(`retake grant lookup: ${grantError.message}`);
    grantId = (grant?.id as string | undefined) ?? null;
  }

  // A concurrent start (Start pressed twice, two devices) may have created
  // its attempt after `latest` was read: its R&W Module 1 then counts in
  // `prior` (→ attempt max+2, or "Retake not allowed"), or it has already
  // used the grant. It inserts the attempt row before both, so re-reading
  // it here catches every such case: resume that attempt instead.
  const again = await latestFlAttempt(db, parent.id, studentId);
  if (again && again.attempt_number > (latest?.attempt_number ?? 0)) return startFlAttempt(db, ctx, studentId, opts);

  if (prior > 0 && !parent.allow_retake && !grantId) return { ok: false, status: 403, error: "Retake not allowed" };

  // Per-test accommodation, else the student's profile testing time.
  // Throws on a lookup error: never start without the extended time.
  const multiplier = await loadTimeMultiplier(db, parent.id, studentId);

  const attemptNumber = prior + 1;
  let attempt: FlAttempt | null = null;
  let created = false;
  const { data: inserted, error: insertError } = await db
    .from("full_length_attempts")
    .insert({
      test_id: parent.id,
      student_id: studentId,
      attempt_number: attemptNumber,
      rw_session_id: globalThis.crypto.randomUUID(),
      time_multiplier: Number.isFinite(multiplier) && multiplier >= 1 ? multiplier : 1,
      break_minutes: parent.break_minutes ?? DEFAULT_BREAK_MINUTES,
      allow_section_pause: Boolean(parent.allow_section_pause),
      started_at: new Date(now).toISOString(),
    })
    .select(FL_ATTEMPT_COLUMNS)
    .single();
  if (!insertError && inserted) {
    attempt = inserted as unknown as FlAttempt;
    created = true;
  } else if (insertError?.code === "23505") {
    // A concurrent start (double click, second tab) won: use its attempt.
    attempt = await attemptByNumber(db, parent.id, studentId, attemptNumber);
  }
  if (!attempt) throw new Error(`full-length attempt insert: ${insertError?.message ?? "no row returned"}`);

  // Consume the grant as soon as the attempt exists (only the request that
  // created it; a missing R&W Module 1 is repaired on resume).
  if (created && grantId) {
    const { error: grantUseError } = await db
      .from("test_retake_grants")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", grantId)
      .is("consumed_at", null);
    if (grantUseError) console.error("[full-length/start] consume grant", grantId, grantUseError.message);
  }

  const m1 = await ensureRwModule1(db, ctx, attempt, opts.device);

  // The test went back to Draft while we were starting (lib/draft-race):
  // undo this request's own rows while still untouched, refuse like Draft.
  if (created && (await testIsDraftNow(db, parent.id))) {
    if (m1.created) await dropUnansweredSubmission(db, m1.id);
    const { data: left, error: leftErr } = await db.from("submissions").select("id").eq("id", m1.id).maybeSingle();
    if (!leftErr && !left) {
      const { error: delErr } = await db.from("full_length_attempts").delete().eq("id", attempt.id);
      if (delErr) console.error("[full-length/start] draft race: attempt delete", attempt.id, delErr.message);
      else if (grantId) await db.from("test_retake_grants").update({ consumed_at: null }).eq("id", grantId);
    }
    return { ok: false, status: 403, error: "Test is not available" };
  }
  console.log("[full-length/start]", parent.id, studentId, attempt.attempt_number, created ? "created" : "adopted");
  return { ok: true, attempt, resumed: !created, submissionId: m1.id };
}

export type StartMathResult =
  | { ok: true; submissionId: string | null; created: boolean }
  | { ok: false; status: number; error: string; retryInSeconds?: number; breakEndsAtMs?: number };

/**
 * Start Math (the lazy clock: Math Module 1 is created, with started_at =
 * now, only when the student opens it). `auto` = the break screen reached
 * 0:00: accepted only when pausing is off and the break really is over
 * (2 s tolerance); otherwise the true remaining time is returned so the
 * client re-syncs. Idempotent: an existing Math Module 1 is returned.
 */
export async function startFlMath(
  db: SupabaseClient,
  ctx: FlContext,
  attempt: FlAttempt,
  opts: { auto?: boolean; device?: DeviceInfo | null; now?: number },
): Promise<StartMathResult> {
  const now = opts.now ?? Date.now();
  const rows = await flAttemptRows(db, ctx, attempt.student_id, attempt.attempt_number);
  const st = stateOf(ctx, attempt, rows, now);

  if (st.state !== "break") {
    if (st.state === "closed") return { ok: false, status: 403, error: "This attempt is closed." };
    if (st.section === "rw") return { ok: false, status: 409, error: "Finish Reading and Writing first." };
    // Math already started (another tab / device) or the attempt is done.
    if (st.unlinkedMathSessionId) await linkMathSession(db, attempt.id, st.unlinkedMathSessionId);
    return { ok: true, submissionId: st.row?.id ?? null, created: false };
  }

  if (ctx.parent.status !== "Published" && ctx.parent.status !== "Closed") {
    return { ok: false, status: 403, error: "Test is not available" };
  }
  if (st.mathStartBlock) {
    return {
      ok: false,
      status: 403,
      error:
        st.mathStartBlock === "closed"
          ? "This attempt is closed."
          : "Math can no longer be started — the due date has passed. Ask your teacher if you need to finish it.",
    };
  }
  if (opts.auto) {
    if (attempt.allow_section_pause) {
      return { ok: false, status: 409, error: "Press Resume testing when you're ready.", breakEndsAtMs: st.breakEndsAtMs! };
    }
    if (autoStartTooEarly(st.breakEndsAtMs!, now)) {
      return {
        ok: false,
        status: 409,
        error: "The break isn't over yet.",
        retryInSeconds: st.breakRemainingSeconds ?? 0,
        breakEndsAtMs: st.breakEndsAtMs!,
      };
    }
  }

  const m1 = await ensureModule1(db, ctx.math, attempt, globalThis.crypto.randomUUID(), opts.device);
  await linkMathSession(db, attempt.id, m1.session_id);
  await clearMathNotStartedClose(db, attempt.id);
  console.log("[full-length/start-math]", attempt.id, opts.auto ? "auto" : "resume", m1.created ? "created" : "adopted");
  return { ok: true, submissionId: m1.id, created: m1.created };
}

/**
 * Bring an attempt to a state the student can act on: insert a missing
 * R&W Module 1 (rw_missing), create a missing Module 2 after a failed
 * handoff (recoverModule2 on the child, treating a Closed test as
 * Published — an existing attempt may finish), and link an unlinked Math
 * session. Returns the resulting state, or `blocked` when a late Module 2
 * may no longer be created (same 24 h rule as section tests).
 */
export async function advanceFlAttempt(
  db: SupabaseClient,
  ctx: FlContext,
  attempt: FlAttempt,
  opts: { device?: DeviceInfo | null } = {},
): Promise<{ state: FlState; blocked: Module2Block | null }> {
  let st = stateOf(ctx, attempt, await flAttemptRows(db, ctx, attempt.student_id, attempt.attempt_number));
  // flState ignores a 'math_not_started' close once Math Module 1 exists
  // (state isn't 'closed'); clear it on the row too so lists and access agree.
  if (attempt.closed_reason === "math_not_started" && st.state !== "closed") {
    await clearMathNotStartedClose(db, attempt.id);
  }
  for (let i = 0; i < 3; i++) {
    if (st.unlinkedMathSessionId) await linkMathSession(db, attempt.id, st.unlinkedMathSessionId);
    if (st.state === "rw_missing") {
      await ensureRwModule1(db, ctx, attempt, opts.device);
    } else if ((st.state === "rw_handoff" || st.state === "math_handoff") && st.row?.session_id) {
      const child = st.state === "rw_handoff" ? ctx.rw : ctx.math;
      const recovered = await recoverModule2(db, child.id, attempt.student_id, { ...child, status: "Published" }, {
        device: opts.device,
        onlySessionId: st.row.session_id,
      });
      if (recovered && "blocked" in recovered) return { state: st, blocked: recovered.blocked };
      if (!recovered) return { state: st, blocked: null }; // not the latest session: leave as is
    } else {
      return { state: st, blocked: null };
    }
    st = stateOf(ctx, attempt, await flAttemptRows(db, ctx, attempt.student_id, attempt.attempt_number));
  }
  return { state: st, blocked: null };
}

// ---------------------------------------------------------------- cron

/** How long one cron run may spend on the close pass (the route has 60 s in all). */
export const FL_CLOSE_BUDGET_MS = 20_000;
/** Candidate attempts looked at per run (newest first). */
const FL_CLOSE_BATCH = 500;
/** Session ids per `.in()` lookup. */
const FL_SESSION_CHUNK = 100;

export type FlCloseReason = "math_not_started" | "abandoned";

/**
 * Why the cron should close this attempt now, or null. Only past the due
 * date (never before), by the one window rule:
 *  - on the break and Math can no longer be started → 'math_not_started';
 *  - stuck where nothing can move it any more → 'abandoned': a Module 2
 *    whose handoff failed and may no longer be created (recovery's 24 h
 *    past-due rule), or an attempt row whose R&W Module 1 was never
 *    created, started more than 24 h ago.
 */
export function flCloseReason(attempt: FlAttempt, st: FlState, dueDate: string | null, now: number): FlCloseReason | null {
  if (!dueDate || Date.parse(dueDate) >= now) return null;
  if (st.state === "break") return st.mathStartBlock === "window_passed" ? "math_not_started" : null;
  if (st.state === "rw_handoff" || st.state === "math_handoff") {
    return module2RecoveryBlock({ status: "Published", due_date: dueDate }, st.row?.submitted_at ?? null, now) === "past_due"
      ? "abandoned"
      : null;
  }
  if (st.state === "rw_missing") {
    return now - Date.parse(attempt.started_at) > FL_LATE_START_WINDOW_HOURS * 3_600_000 ? "abandoned" : null;
  }
  return null;
}

/**
 * Cron pass (auto-finalize-stale-submissions): close attempts that can no
 * longer continue (flCloseReason). Never creates rows. Also links a Math
 * session that start-math created but couldn't link. Only full-length
 * tests whose due date has passed are looked at; attempts newest first,
 * at most FL_CLOSE_BATCH per run, within FL_CLOSE_BUDGET_MS.
 */
export async function closeExpiredFullLengthAttempts(
  db: SupabaseClient,
  now = Date.now(),
  opts: { budgetMs?: number } = {},
): Promise<{ closed: number; linked: number; scanned: number; truncated: boolean; errors: string[] }> {
  const began = Date.now();
  const budget = opts.budgetMs ?? FL_CLOSE_BUDGET_MS;
  const out = { closed: 0, linked: 0, scanned: 0, truncated: false, errors: [] as string[] };

  const { data: parents, error: parentsError } = await db
    .from("tests")
    .select("id, due_date")
    .eq("test_kind", "full_length")
    .lt("due_date", new Date(now).toISOString());
  if (parentsError) {
    out.errors.push(`tests lookup: ${parentsError.message}`);
    return out;
  }
  const due = new Map(((parents ?? []) as { id: string; due_date: string | null }[]).map((p) => [p.id, p.due_date]));
  if (due.size === 0) return out;
  const parentIds = [...due.keys()];

  const { data: kids, error: kidsError } = await db
    .from("tests")
    .select("id, parent_test_id, section_order")
    .in("parent_test_id", parentIds);
  if (kidsError) {
    out.errors.push(`sections lookup: ${kidsError.message}`);
    return out;
  }
  const children = new Map<string, { rw: string; math: string }>();
  for (const k of (kids ?? []) as { id: string; parent_test_id: string; section_order: number }[]) {
    const c = children.get(k.parent_test_id) ?? { rw: "", math: "" };
    if (k.section_order === 1) c.rw = k.id;
    else if (k.section_order === 2) c.math = k.id;
    children.set(k.parent_test_id, c);
  }

  // Unlinked attempts: R&W, the break, rw_missing (and a Math start that
  // couldn't link), newest first.
  const { data: unlinked, error: unlinkedError } = await db
    .from("full_length_attempts")
    .select(FL_ATTEMPT_COLUMNS)
    .in("test_id", parentIds)
    .is("closed_at", null)
    .is("math_session_id", null)
    .order("started_at", { ascending: false })
    .limit(FL_CLOSE_BATCH);
  if (unlinkedError) {
    out.errors.push(`attempts lookup: ${unlinkedError.message}`);
    return out;
  }
  const candidates = (unlinked ?? []) as unknown as FlAttempt[];

  // Linked attempts are only stuck in a failed Math handoff: find those
  // with one bulk read of their Math Module 1 rows (graded, no Module 2).
  const { data: linked, error: linkedError } = await db
    .from("full_length_attempts")
    .select(FL_ATTEMPT_COLUMNS)
    .in("test_id", parentIds)
    .is("closed_at", null)
    .not("math_session_id", "is", null)
    .order("started_at", { ascending: false })
    .limit(FL_CLOSE_BATCH);
  if (linkedError) out.errors.push(`linked attempts lookup: ${linkedError.message}`);
  const linkedAttempts = (linked ?? []) as unknown as FlAttempt[];
  if (linkedAttempts.length > 0) {
    // In chunks, so the session id list stays well inside the URL limit.
    const sessionIds = linkedAttempts.map((a) => a.math_session_id!);
    const hasM2 = new Set<string>();
    let mathLookupFailed = false;
    for (let i = 0; i < sessionIds.length; i += FL_SESSION_CHUNK) {
      const { data: mathRows, error: mathError } = await db
        .from("submissions")
        .select("session_id, adaptive_track")
        .in("session_id", sessionIds.slice(i, i + FL_SESSION_CHUNK));
      if (mathError) {
        out.errors.push(`math rows lookup: ${mathError.message}`);
        mathLookupFailed = true;
        break;
      }
      for (const r of (mathRows ?? []) as { session_id: string; adaptive_track: string | null }[]) {
        if (isModule2Track(r.adaptive_track)) hasM2.add(r.session_id);
      }
    }
    if (!mathLookupFailed) candidates.push(...linkedAttempts.filter((a) => !hasM2.has(a.math_session_id!)));
  }

  for (const a of candidates) {
    if (Date.now() - began > budget) {
      out.truncated = true;
      break;
    }
    const d = due.get(a.test_id) ?? null;
    const c = children.get(a.test_id);
    if (!c?.rw || !c.math) continue;
    out.scanned++;
    try {
      const rows = await flAttemptRows(db, { rw: { id: c.rw }, math: { id: c.math } }, a.student_id, a.attempt_number);
      const st = flState(a, rows, c, { due_date: d }, now);
      if (st.unlinkedMathSessionId) {
        await linkMathSession(db, a.id, st.unlinkedMathSessionId);
        out.linked++;
        continue;
      }
      const reason = flCloseReason(a, st, d, now);
      if (!reason) continue;
      let q = db
        .from("full_length_attempts")
        .update({ closed_at: new Date(now).toISOString(), closed_reason: reason })
        .eq("id", a.id)
        .is("closed_at", null);
      // Never close over a Math start that just happened.
      if (st.state !== "math_handoff") q = q.is("math_session_id", null);
      const { data: closed, error: closeError } = await q.select("id");
      if (closeError) throw new Error(closeError.message);
      if (closed && closed.length > 0) {
        out.closed++;
        console.log("[cron/fl-close]", reason, a.id, a.test_id, a.student_id, a.attempt_number);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.errors.push(`${a.id}: ${msg}`);
      console.error("[cron/fl-close]", a.id, msg);
    }
  }
  if (out.truncated) console.error("[cron/fl-close] time budget reached; the rest waits for the next run");
  return out;
}

// --------------------------------------------------------------- admin

interface AdminRow {
  id: string;
  test_id: string;
  student_id: string;
  attempt_number: number | null;
  metadata: unknown;
}

/** Is this submission part of a full-length attempt? (metadata.fl_attempt_id; section rows never have it) */
export function isFullLengthRow(sub: Pick<AdminRow, "metadata">): boolean {
  const m = sub.metadata as Record<string, unknown> | null | undefined;
  return typeof m?.fl_attempt_id === "string" && m.fl_attempt_id.length > 0;
}

/** The parent and children of a full-length row's test (direct reads, no memo). */
async function rowFamily(db: SupabaseClient, childId: string) {
  const { data: child, error } = await db.from("tests").select("id, parent_test_id").eq("id", childId).maybeSingle();
  if (error) throw new Error(`test lookup: ${error.message}`);
  const parentId = (child?.parent_test_id as string | null | undefined) ?? null;
  if (!parentId) return null;
  const { data: kids, error: kidsError } = await db
    .from("tests")
    .select("id, section_order")
    .eq("parent_test_id", parentId);
  if (kidsError) throw new Error(`sections lookup: ${kidsError.message}`);
  const list = (kids ?? []) as { id: string; section_order: number }[];
  return {
    parentId,
    rw: list.find((k) => k.section_order === 1)?.id ?? null,
    math: list.find((k) => k.section_order === 2)?.id ?? null,
  };
}

/**
 * Admin reset of one module of a full-length attempt, the extra effects
 * (the route still does the ordinary reset of the row afterwards):
 *  - an R&W module: the Math section is deleted (rows + answer_records by
 *    cascade), math_session_id cleared and any close lifted — the break is
 *    recomputed when R&W Module 2 is submitted again;
 *  - a Math module: any close is lifted.
 * A no-op (no query) for section-test rows.
 */
export async function resetFullLengthEffects(db: SupabaseClient, sub: AdminRow): Promise<void> {
  if (!isFullLengthRow(sub)) return;
  const fam = await rowFamily(db, sub.test_id);
  if (!fam) return;
  const n = sub.attempt_number ?? 1;
  const attemptQuery = () =>
    db.from("full_length_attempts").update(
      sub.test_id === fam.rw
        ? { math_session_id: null, closed_at: null, closed_reason: null }
        : { closed_at: null, closed_reason: null },
    );
  if (sub.test_id === fam.rw && fam.math) {
    const { error } = await db
      .from("submissions")
      .delete()
      .eq("test_id", fam.math)
      .eq("student_id", sub.student_id)
      .eq("attempt_number", n);
    if (error) throw new Error(`delete math section: ${error.message}`);
  }
  const { error } = await attemptQuery()
    .eq("test_id", fam.parentId)
    .eq("student_id", sub.student_id)
    .eq("attempt_number", n);
  if (error) throw new Error(`update attempt: ${error.message}`);
}

/**
 * Admin delete of a full-length row deletes the whole attempt: both
 * sections' rows (answer_records cascade) and the attempt row, so no half
 * attempt is left. Returns null for section-test rows (caller deletes the
 * single row as before).
 */
export async function deleteFullLengthAttempt(db: SupabaseClient, sub: AdminRow): Promise<{ deleted: number } | null> {
  if (!isFullLengthRow(sub)) return null;
  const fam = await rowFamily(db, sub.test_id);
  if (!fam) return null;
  const n = sub.attempt_number ?? 1;
  const ids = [fam.rw, fam.math].filter((x): x is string => Boolean(x));
  const { data: gone, error } = await db
    .from("submissions")
    .delete()
    .in("test_id", ids)
    .eq("student_id", sub.student_id)
    .eq("attempt_number", n)
    .select("id");
  if (error) throw new Error(`delete attempt rows: ${error.message}`);
  const { error: attemptError } = await db
    .from("full_length_attempts")
    .delete()
    .eq("test_id", fam.parentId)
    .eq("student_id", sub.student_id)
    .eq("attempt_number", n);
  if (attemptError) throw new Error(`delete attempt: ${attemptError.message}`);
  return { deleted: (gone ?? []).length };
}
