// lib/test-assign.ts
//
// Assign several tests at once (ticket b271dd38): the bulk endpoint
// (/api/admin/tests/bulk-assign) loops over the same per-test writes as the
// single-test routes — the compare-and-swap add on test_assignments that
// /api/admin/tests/[id] PATCH and …/add-students use — and collects one
// result per test. Pure helpers live in lib/test-assign-shared.ts.
//
// Also the only place that reads or writes tests.publish_at /
// publish_at_error (migration 0034). Until it's applied the columns don't
// exist: reads see "nothing scheduled", writes report it so the API can
// answer 503 "database update pending" (same pattern as lib/teacher-qa.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { blockersMessage, loadPublishCheck } from "./test-readiness";
import {
  TESTS_ASSIGNED_TYPE,
  bulkAssignSummary,
  newIds,
  testsAssignedMessage,
  testsPerStudent,
  type BulkAssignTotals,
} from "./test-assign-shared";

type DbError = { code?: string; message?: string; status?: number } | null | undefined;

// ── publish_at columns (migration 0034) ─────────────────────────────────────

/** Pure: the error is "publish_at / publish_at_error doesn't exist yet" (migration 0034 not applied). */
export function isPublishAtColumnMissing(err: DbError): boolean {
  if (!err) return false;
  // Only when the error names one of these columns: another missing column is a real bug.
  const msg = err.message ?? "";
  if (!/publish_at/.test(msg)) return false;
  return (
    err.code === "42703" ||
    err.code === "PGRST204" ||
    err.code === "400" ||
    err.status === 400 ||
    /does not exist|schema cache/.test(msg)
  );
}

export const PUBLISH_AT_PENDING_MESSAGE =
  "Scheduled publishing needs a database update that hasn't been applied yet (database update pending). Assign without a publish time, or try again later.";

/** True once migration 0034 is applied. Throws on any other error. */
export async function publishAtColumnsReady(db: SupabaseClient): Promise<boolean> {
  const { error } = await db.from("tests").select("id, publish_at, publish_at_error").limit(1);
  if (!error) return true;
  if (isPublishAtColumnMissing(error)) return false;
  throw new Error(`publish_at lookup failed: ${error.message}`);
}

export interface PublishSchedule {
  publishAt: string | null;
  error: string | null;
}

/**
 * test id → its schedule, for each of `testIds` (an unknown id or a missing
 * column reads as nothing scheduled). Any other error throws.
 */
export async function readPublishSchedules(db: SupabaseClient, testIds: Iterable<string>): Promise<Map<string, PublishSchedule>> {
  const ids = Array.from(new Set(testIds));
  const out = new Map<string, PublishSchedule>(ids.map((id) => [id, { publishAt: null, error: null }]));
  if (ids.length === 0) return out;
  const { data, error } = await db.from("tests").select("id, publish_at, publish_at_error").in("id", ids);
  if (error) {
    if (isPublishAtColumnMissing(error)) return out;
    throw new Error(`publish_at lookup failed: ${error.message}`);
  }
  for (const r of (data ?? []) as { id: string; publish_at: string | null; publish_at_error: string | null }[]) {
    out.set(r.id, { publishAt: r.publish_at ?? null, error: r.publish_at_error ?? null });
  }
  return out;
}

/**
 * Schedule a Draft to publish at `iso` (clears an earlier error note, so a
 * reschedule is retried). Status-filtered: a test that left Draft is not
 * touched ("not-draft").
 */
export async function writePublishAt(
  db: SupabaseClient,
  testId: string,
  iso: string,
): Promise<"ok" | "not-draft" | "column-missing"> {
  const { data, error } = await db
    .from("tests")
    .update({ publish_at: iso, publish_at_error: null, updated_at: new Date().toISOString() })
    .eq("id", testId)
    .eq("status", "Draft")
    .select("id");
  if (error) {
    if (isPublishAtColumnMissing(error)) return "column-missing";
    throw new Error(`publish_at update failed: ${error.message}`);
  }
  return (data ?? []).length > 0 ? "ok" : "not-draft";
}

/**
 * After a publish (manual or scheduled): forget the schedule, so a test moved
 * back to Draft later doesn't publish itself again from a stale time. Never
 * throws; a missing column is fine.
 */
export async function clearPublishSchedule(db: SupabaseClient, testId: string): Promise<void> {
  try {
    const { error } = await db.from("tests").update({ publish_at: null, publish_at_error: null }).eq("id", testId);
    if (error && !isPublishAtColumnMissing(error)) console.error("[publish_at] clear failed:", testId, error.message);
  } catch (e) {
    console.error("[publish_at] clear threw:", testId, e instanceof Error ? e.message : e);
  }
}

/** Keep the schedule but mark it failed (not retried until an admin reschedules). Draft only. */
export async function writePublishAtError(db: SupabaseClient, testId: string, note: string): Promise<void> {
  const { error } = await db
    .from("tests")
    .update({ publish_at_error: note })
    .eq("id", testId)
    .eq("status", "Draft");
  if (error && !isPublishAtColumnMissing(error)) throw new Error(`publish_at_error update failed: ${error.message}`);
}

// ── test_assignments compare-and-swap ───────────────────────────────────────

export type AssignmentField = "class_group_ids" | "student_ids" | "teacher_ids";

/**
 * Atomically adds/removes ids on a jsonb string-array column of
 * test_assignments via compare-and-swap; retries up to 5 times on a
 * conflict (a concurrent writer changed the value). Returns the ids it
 * actually added (already-present ones are skipped), or {message, status}.
 */
export async function casAssignmentArray(
  db: SupabaseClient,
  testId: string,
  field: AssignmentField,
  toAdd: string[],
  toRemove: Set<string> = new Set(),
): Promise<{ added: string[] } | { message: string; status: number }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error: readErr } = await db
      .from("test_assignments")
      .select(field)
      .eq("test_id", testId)
      .maybeSingle();
    if (readErr) return { message: "Could not read test assignment", status: 500 };
    if (!row) return { message: "Test assignment not found", status: 404 };
    const rowRecord = row as Record<string, unknown>;
    const old: string[] = Array.isArray(rowRecord[field]) ? (rowRecord[field] as string[]) : [];
    const added = newIds(old, toAdd);
    const next = [...new Set([...old.filter((v) => !toRemove.has(v)), ...toAdd])];
    if (JSON.stringify(old) === JSON.stringify(next)) return { added: [] }; // no-op
    // CAS: only commit if no concurrent writer changed the field between read and write.
    const { data: updated, error: updErr } = await db
      .from("test_assignments")
      .update({ [field]: next })
      .eq("test_id", testId)
      .filter(field, "eq", JSON.stringify(old))
      .select("test_id");
    // A real write error is not a conflict — report it instead of retrying.
    if (updErr) return { message: `Assignment update failed: ${updErr.message}`, status: 500 };
    if ((updated ?? []).length > 0) return { added }; // committed
    if (attempt < 4) await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
  }
  return { message: "Concurrent update conflict — please retry", status: 409 };
}

// ── bulk assign ─────────────────────────────────────────────────────────────

export interface BulkAssignInput {
  testIds: string[];
  studentIds: string[];
  classGroupIds: string[];
  teacherIds: string[];
  /** Absolute ISO time for Drafts to publish at, or null (Drafts stay Draft). */
  publishAt: string | null;
}

export interface BulkAssignTestResult {
  testId: string;
  name: string;
  status: string | null;
  outcome: "assigned" | "refused" | "failed";
  error?: string;
  studentsAdded: number;
  classesAdded: number;
  teachersAdded: number;
  /** Students who can now see the test (direct + through new classes). */
  studentsReached: number;
  skipped: number;
  /** Set when this request scheduled the Draft. */
  publishAt: string | null;
  /** A scheduled Draft that would not pass the publish check right now. */
  notReady?: string;
}

export interface BulkAssignResult {
  results: BulkAssignTestResult[];
  totals: BulkAssignTotals;
  summary: string;
  notified: number;
}

type TestRow = { id: string; test_name: string; status: string | null; test_kind: string | null; parent_test_id: string | null };
type AssignRow = { test_id: string; student_ids: string[] | null; class_group_ids: string[] | null; teacher_ids: string[] | null };

/**
 * Assign every test in `input.testIds` to the given students / classes /
 * teachers. Already-assigned pairs are skipped (a student who already sees
 * the test through a class counts as assigned), Closed tests and
 * full-length sections are refused, Drafts optionally get a publish time.
 * One bell notification per student, listing the tests they can now see
 * (Published, or Draft with a publish time). Callers authorize and
 * validate ids first; a missing publish_at column must be checked before
 * (publishAtColumnsReady), so nothing is half-written.
 */
export async function bulkAssign(db: SupabaseClient, input: BulkAssignInput, now: Date = new Date()): Promise<BulkAssignResult> {
  const testIds = Array.from(new Set(input.testIds));
  const studentIds = Array.from(new Set(input.studentIds));
  const classIds = Array.from(new Set(input.classGroupIds));
  const teacherIds = Array.from(new Set(input.teacherIds));

  const [{ data: testRows, error: testErr }, { data: assignRows, error: assignErr }] = await Promise.all([
    db.from("tests").select("id, test_name, status, test_kind, parent_test_id").in("id", testIds),
    db.from("test_assignments").select("test_id, student_ids, class_group_ids, teacher_ids").in("test_id", testIds),
  ]);
  if (testErr) throw new Error(`tests lookup failed: ${testErr.message}`);
  if (assignErr) throw new Error(`test_assignments lookup failed: ${assignErr.message}`);
  const testById = new Map(((testRows ?? []) as TestRow[]).map((t) => [t.id, t]));
  const assignById = new Map(((assignRows ?? []) as AssignRow[]).map((a) => [a.test_id, a]));

  // Members of every class involved (already on a test, or being added).
  const allClassIds = Array.from(
    new Set([...classIds, ...Array.from(assignById.values()).flatMap((a) => a.class_group_ids ?? [])]),
  );
  const membersOf = new Map<string, string[]>();
  if (allClassIds.length > 0) {
    const { data: members, error: memberErr } = await db
      .from("class_group_members")
      .select("class_group_id, student_id")
      .in("class_group_id", allClassIds);
    if (memberErr) throw new Error(`class members lookup failed: ${memberErr.message}`);
    for (const m of (members ?? []) as { class_group_id: string; student_id: string }[]) {
      membersOf.set(m.class_group_id, [...(membersOf.get(m.class_group_id) ?? []), m.student_id]);
    }
  }

  const results: BulkAssignTestResult[] = [];
  const reachedForNotice = new Map<string, string[]>();
  const noticeTest = new Map<string, { name: string; publishAt: string | null }>();

  for (const testId of testIds) {
    const t = testById.get(testId);
    const base: BulkAssignTestResult = {
      testId,
      name: t?.test_name ?? "Unknown test",
      status: t?.status ?? null,
      outcome: "assigned",
      studentsAdded: 0,
      classesAdded: 0,
      teachersAdded: 0,
      studentsReached: 0,
      skipped: 0,
      publishAt: null,
    };
    const fail = (outcome: "refused" | "failed", error: string) => results.push({ ...base, outcome, error });
    if (!t) { fail("failed", "Test not found"); continue; }
    if (t.parent_test_id || t.test_kind === "fl_section") {
      fail("refused", "This is a section of a full-length SAT — assign the full-length test instead.");
      continue;
    }
    if (t.status === "Closed") { fail("refused", "Closed tests can't be assigned. Reopen the test first."); continue; }
    const a = assignById.get(testId);
    if (!a) { fail("failed", "Test assignment not found"); continue; }

    const access = new Set([...(a.student_ids ?? []), ...(a.class_group_ids ?? []).flatMap((c) => membersOf.get(c) ?? [])]);
    const r = { ...base };
    const errors: string[] = [];

    // Students: skip anyone who can already see the test.
    const freshStudents = studentIds.filter((s) => !access.has(s));
    r.skipped += studentIds.length - freshStudents.length;
    let addedStudents: string[] = [];
    if (freshStudents.length > 0) {
      const res = await casAssignmentArray(db, testId, "student_ids", freshStudents);
      if ("added" in res) {
        addedStudents = res.added;
        r.skipped += freshStudents.length - res.added.length; // added meanwhile by someone else
      } else errors.push(res.message);
    }

    // Classes: skip the ones already on the test.
    const freshClasses = newIds(a.class_group_ids ?? [], classIds);
    r.skipped += classIds.length - freshClasses.length;
    let addedClasses: string[] = [];
    if (freshClasses.length > 0) {
      const res = await casAssignmentArray(db, testId, "class_group_ids", freshClasses);
      if ("added" in res) {
        addedClasses = res.added;
        r.skipped += freshClasses.length - res.added.length;
      } else errors.push(res.message);
    }

    // Teachers: added to the existing set, never replacing it.
    const freshTeachers = newIds(a.teacher_ids ?? [], teacherIds);
    r.skipped += teacherIds.length - freshTeachers.length;
    if (freshTeachers.length > 0) {
      const res = await casAssignmentArray(db, testId, "teacher_ids", freshTeachers);
      if ("added" in res) {
        r.teachersAdded = res.added.length;
        r.skipped += freshTeachers.length - res.added.length;
      } else errors.push(res.message);
    }

    r.studentsAdded = addedStudents.length;
    r.classesAdded = addedClasses.length;
    const reached = newIds(access, [...addedStudents, ...addedClasses.flatMap((c) => membersOf.get(c) ?? [])]);
    r.studentsReached = reached.length;

    // Draft + publish time: schedule it, and say now if it wouldn't pass.
    if (input.publishAt && t.status === "Draft") {
      try {
        const w = await writePublishAt(db, testId, input.publishAt);
        if (w === "ok") {
          r.publishAt = input.publishAt;
          const check = await loadPublishCheck(db, testId);
          if (check && !check.canPublish) r.notReady = blockersMessage(check.blockers);
        } else if (w === "column-missing") errors.push(PUBLISH_AT_PENDING_MESSAGE);
        else errors.push("The test is no longer a Draft, so no publish time was set.");
      } catch (e) {
        errors.push(e instanceof Error ? e.message : "Could not set the publish time");
      }
    }

    // Students hear about tests they can see: Published, or scheduled.
    if (reached.length > 0 && (t.status === "Published" || r.publishAt)) {
      reachedForNotice.set(testId, reached);
      noticeTest.set(testId, { name: t.test_name, publishAt: r.publishAt });
    }

    if (errors.length > 0) {
      r.error = errors.join("; ");
      // Something may have been written before the error; it still counts.
      const wrote = r.studentsAdded + r.classesAdded + r.teachersAdded > 0 || r.publishAt;
      r.outcome = wrote ? "assigned" : "failed";
    }
    results.push(r);
  }

  const notified = await notifyStudents(db, reachedForNotice, noticeTest, now);

  const assigned = results.filter((r) => r.outcome === "assigned");
  const totals: BulkAssignTotals = {
    tests: assigned.length,
    students: assigned.length > 0 ? studentIds.length : 0,
    classes: assigned.length > 0 ? classIds.length : 0,
    teachers: assigned.length > 0 ? teacherIds.length : 0,
    skipped: results.reduce((n, r) => n + r.skipped, 0),
    scheduled: results.flatMap((r) => (r.publishAt ? [r.publishAt] : [])),
    refused: results.filter((r) => r.outcome === "refused").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    added: assigned.reduce((n, r) => n + r.studentsAdded + r.classesAdded + r.teachersAdded, 0),
  };
  return { results, totals, summary: bulkAssignSummary(totals, now), notified };
}

/** One bell notification per student for the whole request. Never throws. */
async function notifyStudents(
  db: SupabaseClient,
  reached: Map<string, string[]>,
  tests: Map<string, { name: string; publishAt: string | null }>,
  now: Date,
): Promise<number> {
  const perStudent = testsPerStudent(reached);
  if (perStudent.size === 0) return 0;
  const rows = Array.from(perStudent, ([userId, ids]) => {
    const list = ids.map((id) => tests.get(id)!).filter(Boolean);
    const { title, message } = testsAssignedMessage(list, now);
    return {
      user_id: userId,
      type: TESTS_ASSIGNED_TYPE,
      payload: { kind: TESTS_ASSIGNED_TYPE, title, message, test_ids: ids, test_names: list.map((t) => t.name) },
    };
  });
  try {
    const { error } = await db.from("notifications").insert(rows);
    if (error) {
      console.error("[bulk-assign] notifications insert failed:", error.message);
      return 0;
    }
    return rows.length;
  } catch (e) {
    console.error("[bulk-assign] notifications insert threw:", e instanceof Error ? e.message : e);
    return 0;
  }
}
