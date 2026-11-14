// lib/module2-handoff.ts
//
// Module 1 → Module 2 handoff for two-module (adaptive or fixed) tests.
// One implementation shared by every path that can close a Module 1:
//   - the student's own submit (POST /api/student/submissions/[id]/submit),
//   - the cron finalizer (Module 1 time ran out),
//   - recovery when the student comes back (POST /api/student/submissions
//     "Continue to Module 2", and the take page itself).
//
// Idempotent: a session gets at most one Module 2 row, however many of
// these run at once. The existing row is reused; a concurrent insert of
// the same track is refused by uniq_submissions_attempt_adaptive (one row
// per test/student/attempt/track) and we adopt the winner; migration 0030
// adds one-Module-2-per-session for the different-track case, which the
// post-insert check below also covers.
//
// The Module 2 clock does NOT start here: the row is created without
// metadata.module_2_started_at and the take page stamps it when the
// student presses "Start Module 2" (lib/student-exam moduleStartedAtIso).

import type { SupabaseClient } from "@supabase/supabase-js";
import { FULL_LENGTH_METADATA_KEYS, type DeviceInfo } from "@/lib/student-exam";

export const MODULE_2_TRACKS = ["module_2", "module_2_easy", "module_2_hard"] as const;
export type Module2Track = (typeof MODULE_2_TRACKS)[number];

/** Test columns the handoff needs. */
export interface HandoffTest {
  is_adaptive: boolean | null;
  module_2_id: string | null;
  module_2_easy_id: string | null;
  module_2_hard_id: string | null;
  adaptive_threshold: number | null;
}
export const HANDOFF_TEST_COLUMNS =
  "is_adaptive, module_2_id, module_2_easy_id, module_2_hard_id, adaptive_threshold";

/** The (graded) Module 1 row being handed off from. */
export interface HandoffModule1 {
  test_id: string;
  student_id: string;
  session_id: string | null;
  attempt_number: number;
  adaptive_track: string | null;
  /**
   * Module 1's metadata. Only its full-length keys (extended time, attempt
   * link, attempt start) are carried to Module 2; section tests have none,
   * so leaving it out changes nothing.
   */
  metadata?: unknown;
}

/** The full-length keys of a Module 1's metadata that Module 2 inherits. */
export function carriedModule1Metadata(metadata: unknown): Record<string, unknown> {
  const meta = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of FULL_LENGTH_METADATA_KEYS) if (meta[k] !== undefined) out[k] = meta[k];
  return out;
}

/**
 * Which Module 2 this attempt continues with, or null when the test has
 * none. Adaptive: hard at/above the threshold, else easy, falling back to
 * the other track when the chosen one isn't configured.
 */
export function pickModule2(
  test: HandoffTest,
  module1Percentage: number,
): { moduleId: string; track: Module2Track } | null {
  if (test.is_adaptive) {
    const threshold = test.adaptive_threshold ?? 60;
    const wantHard = module1Percentage >= threshold;
    const hard = test.module_2_hard_id ?? null;
    const easy = test.module_2_easy_id ?? null;
    if (wantHard) {
      if (hard) return { moduleId: hard, track: "module_2_hard" };
      if (easy) return { moduleId: easy, track: "module_2_easy" };
    } else {
      if (easy) return { moduleId: easy, track: "module_2_easy" };
      if (hard) return { moduleId: hard, track: "module_2_hard" };
    }
    return null;
  }
  if (test.module_2_id) return { moduleId: test.module_2_id, track: "module_2" };
  return null;
}

/** Test columns the recovery paths also need (policy checks). */
export interface RecoveryTest extends HandoffTest {
  status: string | null;
  due_date: string | null;
}
export const RECOVERY_TEST_COLUMNS = `status, due_date, ${HANDOFF_TEST_COLUMNS}`;

/**
 * After the due date, a missing Module 2 may still be created this long
 * after Module 1 was graded (same window the cron gives an unopened
 * Module 2). Later than that the attempt is closed.
 */
export const MODULE_2_LATE_RECOVERY_HOURS = 24;

export type Module2Block = "not_published" | "past_due";

/**
 * Why a missing Module 2 may NOT be created now by a recovery path, or
 * null when it may. Only gates creating a row: an existing Module 2 is
 * always handed back. (A student's own submit and the cron create it
 * right at the Module 1 close and don't go through this.)
 */
export function module2RecoveryBlock(
  test: Pick<RecoveryTest, "status" | "due_date">,
  module1SubmittedAt: string | null,
  now = Date.now(),
): Module2Block | null {
  // Closed only stops new attempts: an attempt whose Module 1 is graded may
  // still get its Module 2 (same as full-length attempts on a Closed test).
  if (test.status !== "Published" && test.status !== "Closed") return "not_published";
  if (test.due_date && new Date(test.due_date).getTime() < now) {
    const graded = module1SubmittedAt ? new Date(module1SubmittedAt).getTime() : NaN;
    if (!(now - graded <= MODULE_2_LATE_RECOVERY_HOURS * 3_600_000)) return "past_due";
  }
  return null;
}

async function module2Rows(db: SupabaseClient, m1: HandoffModule1) {
  const { data, error } = await db
    .from("submissions")
    .select("id, answers, metadata")
    .eq("session_id", m1.session_id)
    .eq("student_id", m1.student_id)
    .in("adaptive_track", MODULE_2_TRACKS as unknown as string[])
    .order("started_at", { ascending: true })
    .order("id", { ascending: true })
    // This is re-read after the insert. Inside a Server Component render
    // (the take page) Next.js memoizes identical GET fetches, so the
    // re-read would return the stale pre-insert result; a signal opts
    // the request out of that.
    .abortSignal(new AbortController().signal);
  if (error) throw new Error(`module 2 lookup: ${error.message}`);
  return (data ?? []) as { id: string; answers: unknown; metadata: unknown }[];
}

/** The Module 2 row of this Module 1's session, if any. Never inserts. */
export async function findModule2(db: SupabaseClient, m1: HandoffModule1): Promise<string | null> {
  if (!m1.session_id) return null;
  return (await module2Rows(db, m1))[0]?.id ?? null;
}

/**
 * Make sure the session of this (already graded) Module 1 has its Module 2
 * row. Returns that row's id (created: true only for the call that
 * inserted it), or null when the test has no Module 2 / the row isn't a
 * session Module 1. Throws on database errors so callers can retry.
 */
export async function ensureModule2(
  db: SupabaseClient,
  m1: HandoffModule1,
  test: HandoffTest,
  opts: {
    module1Percentage: number;
    device?: DeviceInfo | null;
    /** Recovery past the due date: the new row is graded Late. */
    createdAfterDue?: boolean;
  },
): Promise<{ id: string; created: boolean } | null> {
  if (m1.adaptive_track !== "module_1" || !m1.session_id) return null;
  const next = pickModule2(test, opts.module1Percentage);
  if (!next) return null;

  const existing = await module2Rows(db, m1);
  if (existing.length > 0) return { id: existing[0].id, created: false };

  const { data: inserted, error } = await db
    .from("submissions")
    .insert({
      test_id: m1.test_id,
      student_id: m1.student_id,
      answers: {},
      status: "In Progress",
      started_at: new Date().toISOString(),
      attempt_number: m1.attempt_number,
      metadata: {
        ...carriedModule1Metadata(m1.metadata),
        ...(opts.device ? { device: opts.device } : {}),
        ...(opts.createdAfterDue ? { created_after_due: true } : {}),
      },
      session_id: m1.session_id,
      module_id: next.moduleId,
      adaptive_track: next.track,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    // 23505 = a concurrent handoff inserted it first: use theirs.
    if (error?.code === "23505") {
      const winner = await module2Rows(db, m1);
      if (winner.length > 0) return { id: winner[0].id, created: false };
    }
    throw new Error(`module 2 insert: ${error?.message ?? "no row returned"}`);
  }

  // Two handoffs that picked different tracks aren't stopped by the
  // per-track unique index (only by migration 0030). Keep the oldest row;
  // if that isn't ours, remove ours — but only while it is untouched
  // (never opened, no answers). A row someone already started is kept.
  const rows = await module2Rows(db, m1);
  if (rows.length > 1 && rows[0].id !== inserted.id) {
    const { data: removed } = await db
      .from("submissions")
      .delete()
      .eq("id", inserted.id)
      .eq("status", "In Progress")
      .eq("answers", "{}")
      .is("metadata->module_2_started_at", null)
      .select("id");
    if (removed && removed.length > 0) return { id: rows[0].id, created: false };
  }
  return { id: inserted.id, created: true };
}

/**
 * Recovery for a student who comes back to a test whose latest session has
 * Module 1 graded but no Module 2 (handoff failed, the cron closed Module 1
 * before this code existed, the browser crashed...). Creates the missing
 * Module 2 and returns its id (or the session's open Module 2 when one
 * already exists, e.g. made by a concurrent request); null when there is
 * nothing to recover;
 * { blocked } when it may not be created now (module2RecoveryBlock).
 * Only ever the student's LATEST session: with onlySessionId, nothing is
 * done unless that session is the latest one. The caller checks the
 * student may take the test at all (lib/module2-access).
 */
export async function recoverModule2(
  db: SupabaseClient,
  testId: string,
  studentId: string,
  test: RecoveryTest,
  opts: { device?: DeviceInfo | null; onlySessionId?: string } = {},
): Promise<{ id: string; created: boolean } | { blocked: Module2Block } | null> {
  if (!test.is_adaptive && !test.module_2_id) return null;
  const { data: rows, error } = await db
    .from("submissions")
    .select("id, test_id, student_id, status, session_id, adaptive_track, attempt_number, started_at, submitted_at, percentage, metadata")
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .not("session_id", "is", null)
    .order("started_at", { ascending: false });
  if (error) throw new Error(`recovery lookup: ${error.message}`);
  const latestSessionId = rows?.[0]?.session_id as string | undefined;
  if (!latestSessionId) return null;
  if (opts.onlySessionId && opts.onlySessionId !== latestSessionId) return null;
  const session = (rows ?? []).filter((r) => r.session_id === latestSessionId);
  const m1 = session.find((r) => r.adaptive_track === "module_1");
  if (!m1 || (m1.status !== "Submitted" && m1.status !== "Late")) return null;
  const m2 = session.filter((r) => (MODULE_2_TRACKS as readonly string[]).includes(String(r.adaptive_track)));
  if (m2.length > 0) {
    // Already there: usually a concurrent handoff/recovery (another tab's
    // "Continue to Module 2") created it after the caller looked for an
    // open row. Hand back the session's Module 2 — the oldest by
    // started_at, then id, as module2Rows picks — only while it is still
    // open; a finished one means nothing to recover.
    const oldest = [...m2].sort((a, b) =>
      String(a.started_at).localeCompare(String(b.started_at)) || String(a.id).localeCompare(String(b.id)),
    )[0];
    return oldest.status === "In Progress" ? { id: oldest.id as string, created: false } : null;
  }
  const blocked = module2RecoveryBlock(test, (m1.submitted_at as string | null) ?? null);
  if (blocked) return { blocked };
  return ensureModule2(
    db,
    {
      test_id: m1.test_id as string,
      student_id: m1.student_id as string,
      session_id: latestSessionId,
      attempt_number: (m1.attempt_number as number) ?? 1,
      adaptive_track: "module_1",
      metadata: m1.metadata,
    },
    test,
    {
      module1Percentage: m1.percentage != null ? Number(m1.percentage) : 0,
      device: opts.device,
      // Inside the 24 h past-due window: allowed, but graded Late.
      createdAfterDue: !!test.due_date && new Date(test.due_date).getTime() < Date.now(),
    },
  );
}
