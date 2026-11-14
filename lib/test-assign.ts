// lib/test-assign.ts
//
// Assign several tests at once (ticket b271dd38): the bulk endpoint
// (/api/admin/tests/bulk-assign) loops over the same per-test writes as the
// single-test routes — the compare-and-swap add on test_assignments that
// /api/admin/tests/[id] PATCH uses — and collects one result per test. Pure
// helpers live in lib/test-assign-shared.ts.
//
// Also the only place that reads or writes tests.publish_at /
// publish_at_error (migration 0034, whose trigger also clears both whenever
// a test leaves Draft). Until it's applied the columns don't exist: reads see
// "nothing scheduled", writes report it so the API can answer 503 "database
// update pending" (same pattern as lib/teacher-qa.ts).

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

type DbError = { code?: string; message?: string } | null | undefined;

// ── publish_at columns (migration 0034) ─────────────────────────────────────

/**
 * Pure: the error is "publish_at / publish_at_error doesn't exist yet"
 * (migration 0034 not applied): Postgres 42703, PostgREST PGRST204, or a
 * "does not exist" / "schema cache" message — and only when it names one of
 * these columns (another missing column is a real bug).
 */
export function isPublishAtColumnMissing(err: DbError): boolean {
  if (!err) return false;
  const msg = err.message ?? "";
  if (!/publish_at/.test(msg)) return false;
  return err.code === "42703" || err.code === "PGRST204" || /does not exist|schema cache/.test(msg);
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
 * touched ("not-draft"). A DB error is logged and thrown as a fixed message.
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
    console.error("[publish_at] set failed:", testId, error.message);
    throw new Error("Could not set the publish time");
  }
  return (data ?? []).length > 0 ? "ok" : "not-draft";
}

/**
 * Forget a test's schedule (Unschedule, a manual publish, back to Draft).
 * Returns false only on a real DB error (logged); a missing column is fine.
 */
export async function clearPublishSchedule(db: SupabaseClient, testId: string): Promise<boolean> {
  try {
    const { error } = await db.from("tests").update({ publish_at: null, publish_at_error: null }).eq("id", testId);
    if (!error || isPublishAtColumnMissing(error)) return true;
    console.error("[publish_at] clear failed:", testId, error.message);
    return false;
  } catch (e) {
    console.error("[publish_at] clear threw:", testId, e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Keep the schedule but mark it failed (not retried until an admin
 * reschedules). Draft only: returns whether a row was updated. Throws on a
 * DB error (logged; fixed message).
 */
export async function writePublishAtError(db: SupabaseClient, testId: string, note: string): Promise<boolean> {
  const { data, error } = await db
    .from("tests")
    .update({ publish_at_error: note })
    .eq("id", testId)
    .eq("status", "Draft")
    .not("publish_at", "is", null)
    .select("id");
  if (error) {
    console.error("[publish_at] error-note write failed:", testId, error.message);
    throw new Error("Could not record the publish failure");
  }
  return (data ?? []).length > 0;
}

// ── test_assignments compare-and-swap ───────────────────────────────────────

export type AssignmentField = "class_group_ids" | "student_ids" | "teacher_ids";

/**
 * Atomically adds/removes ids on a jsonb string-array column of
 * test_assignments via compare-and-swap; retries up to 5 times on a
 * conflict (a concurrent writer changed the value). Returns the ids it
 * actually added (already-present ones are skipped), or {message, status}
 * with a fixed message (DB details are logged).
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
    if (readErr) {
      console.error("[test_assignments] read failed:", testId, readErr.message);
      return { message: "Could not read test assignment", status: 500 };
    }
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
    if (updErr) {
      console.error("[test_assignments] update failed:", testId, field, updErr.message);
      return { message: "Could not update the assignment", status: 500 };
    }
    if ((updated ?? []).length > 0) return { added }; // committed
    if (attempt < 4) await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
  }
  return { message: "Concurrent update conflict — please retry", status: 409 };
}

// ── notifications ───────────────────────────────────────────────────────────

/** One bell notification per student, listing their tests. Returns the rows inserted (ids) or [] (logged). */
export async function insertTestsAssignedNotices(
  db: SupabaseClient,
  perStudent: Map<string, string[]>,
  names: Map<string, string>,
  now: Date = new Date(),
): Promise<{ id: string; user_id: string }[]> {
  if (perStudent.size === 0) return [];
  const rows = Array.from(perStudent, ([userId, ids]) => ({ user_id: userId, type: TESTS_ASSIGNED_TYPE, payload: noticePayload(ids, names, now) }));
  try {
    const { data, error } = await db.from("notifications").insert(rows).select("id, user_id");
    if (error) {
      console.error("[tests_assigned] notifications insert failed:", error.message);
      return [];
    }
    return (data ?? []) as { id: string; user_id: string }[];
  } catch (e) {
    console.error("[tests_assigned] notifications insert threw:", e instanceof Error ? e.message : e);
    return [];
  }
}

function noticePayload(testIds: string[], names: Map<string, string>, now: Date) {
  const list = testIds.map((id) => ({ name: names.get(id) ?? "Test" }));
  const { title, message } = testsAssignedMessage(list, now);
  return { kind: TESTS_ASSIGNED_TYPE, title, message, test_ids: testIds, test_names: list.map((t) => t.name) };
}

/**
 * Students who can see `testIds` (direct + through their classes): test id →
 * student ids. For the notice sent when a scheduled Draft publishes.
 */
export async function assignedStudents(db: SupabaseClient, testIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (testIds.length === 0) return out;
  const { data: rows, error } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids")
    .in("test_id", testIds);
  if (error) throw new Error(`test_assignments lookup failed: ${error.message}`);
  const classIds = Array.from(new Set((rows ?? []).flatMap((r) => (r.class_group_ids ?? []) as string[])));
  const membersOf = new Map<string, string[]>();
  if (classIds.length > 0) {
    const { data: members, error: mErr } = await db.from("class_group_members").select("class_group_id, student_id").in("class_group_id", classIds);
    if (mErr) throw new Error(`class members lookup failed: ${mErr.message}`);
    for (const m of (members ?? []) as { class_group_id: string; student_id: string }[]) {
      membersOf.set(m.class_group_id, [...(membersOf.get(m.class_group_id) ?? []), m.student_id]);
    }
  }
  for (const r of (rows ?? []) as { test_id: string; student_ids: string[] | null; class_group_ids: string[] | null }[]) {
    out.set(r.test_id, Array.from(new Set([...(r.student_ids ?? []), ...(r.class_group_ids ?? []).flatMap((c) => membersOf.get(c) ?? [])])));
  }
  return out;
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

/** Tests written at the same time. */
const PARALLEL = 5;

type TestRow = { id: string; test_name: string; status: string | null; test_kind: string | null; parent_test_id: string | null };
type AssignRow = { test_id: string; student_ids: string[] | null; class_group_ids: string[] | null; teacher_ids: string[] | null };

/**
 * Assign every test in `input.testIds` to the given students / classes /
 * teachers, PARALLEL tests at a time. Already-assigned pairs are skipped (a
 * student who already sees the test through a class counts as assigned),
 * Closed tests and full-length sections are refused, Drafts optionally get a
 * publish time. Callers authorize and validate ids first; a missing
 * publish_at column must be checked before (publishAtColumnsReady).
 *
 * Students hear about Published tests only (a scheduled Draft notifies its
 * students when the cron publishes it). The notices are planned from the
 * pre-read and inserted BEFORE any write — one per student for the request —
 * so a request cut off by the time limit can't leave students un-notified;
 * a test whose write then fails is taken back out of the notices afterwards.
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
  const accessOf = (a: AssignRow) =>
    new Set([...(a.student_ids ?? []), ...(a.class_group_ids ?? []).flatMap((c) => membersOf.get(c) ?? [])]);

  // Notification plan from the pre-read, saved before any write.
  const planned = new Map<string, string[]>();
  const names = new Map<string, string>();
  for (const testId of testIds) {
    const t = testById.get(testId);
    const a = assignById.get(testId);
    if (!t || !a || t.status !== "Published" || t.parent_test_id || t.test_kind === "fl_section") continue;
    const access = accessOf(a);
    const reach = newIds(access, [
      ...studentIds,
      ...newIds(a.class_group_ids ?? [], classIds).flatMap((c) => membersOf.get(c) ?? []),
    ]);
    if (reach.length > 0) {
      planned.set(testId, reach);
      names.set(testId, t.test_name);
    }
  }
  const noticeRows = await insertTestsAssignedNotices(db, testsPerStudent(planned), names, now);

  async function one(testId: string): Promise<BulkAssignTestResult> {
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
    if (!t) return { ...base, outcome: "failed", error: "Test not found" };
    if (t.parent_test_id || t.test_kind === "fl_section") {
      return { ...base, outcome: "refused", error: "This is a section of a full-length SAT — assign the full-length test instead." };
    }
    if (t.status === "Closed") return { ...base, outcome: "refused", error: "Closed tests can't be assigned. Reopen the test first." };
    const a = assignById.get(testId);
    if (!a) return { ...base, outcome: "failed", error: "Test assignment not found" };

    const access = accessOf(a);
    const r = { ...base };
    const errors: string[] = [];
    const added = { students: [] as string[], classes: [] as string[], teachers: [] as string[] };

    // Students: skip anyone who can already see the test.
    const freshStudents = studentIds.filter((s) => !access.has(s));
    r.skipped += studentIds.length - freshStudents.length;
    if (freshStudents.length > 0) {
      const res = await casAssignmentArray(db, testId, "student_ids", freshStudents);
      if ("added" in res) {
        added.students = res.added;
        r.skipped += freshStudents.length - res.added.length; // added meanwhile by someone else
      } else errors.push(res.message);
    }

    // Classes: skip the ones already on the test.
    const freshClasses = newIds(a.class_group_ids ?? [], classIds);
    r.skipped += classIds.length - freshClasses.length;
    if (freshClasses.length > 0) {
      const res = await casAssignmentArray(db, testId, "class_group_ids", freshClasses);
      if ("added" in res) {
        added.classes = res.added;
        r.skipped += freshClasses.length - res.added.length;
      } else errors.push(res.message);
    }

    // Teachers: added to the existing set, never replacing it.
    const freshTeachers = newIds(a.teacher_ids ?? [], teacherIds);
    r.skipped += teacherIds.length - freshTeachers.length;
    if (freshTeachers.length > 0) {
      const res = await casAssignmentArray(db, testId, "teacher_ids", freshTeachers);
      if ("added" in res) {
        added.teachers = res.added;
        r.skipped += freshTeachers.length - res.added.length;
      } else errors.push(res.message);
    }

    r.studentsAdded = added.students.length;
    r.classesAdded = added.classes.length;
    r.teachersAdded = added.teachers.length;
    r.studentsReached = newIds(access, [...added.students, ...added.classes.flatMap((c) => membersOf.get(c) ?? [])]).length;
    addedIds.set(testId, added);

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
        console.error("[bulk-assign] schedule", testId, e);
        errors.push("Could not set the publish time");
      }
    }

    if (errors.length > 0) {
      r.error = errors.join("; ");
      // Something may have been written before the error; it still counts.
      const wrote = r.studentsAdded + r.classesAdded + r.teachersAdded > 0 || r.publishAt;
      r.outcome = wrote ? "assigned" : "failed";
    }
    return r;
  }

  const addedIds = new Map<string, { students: string[]; classes: string[]; teachers: string[] }>();
  const results: BulkAssignTestResult[] = new Array(testIds.length);
  for (let i = 0; i < testIds.length; i += PARALLEL) {
    const batch = testIds.slice(i, i + PARALLEL);
    const out = await Promise.all(
      batch.map((id) =>
        one(id).catch((e): BulkAssignTestResult => {
          console.error("[bulk-assign] test", id, e);
          return {
            testId: id, name: testById.get(id)?.test_name ?? "Unknown test", status: testById.get(id)?.status ?? null,
            outcome: "failed", error: "Could not assign this test", studentsAdded: 0, classesAdded: 0, teachersAdded: 0,
            studentsReached: 0, skipped: 0, publishAt: null,
          };
        }),
      ),
    );
    out.forEach((r, k) => (results[i + k] = r));
  }

  // Take back notices for pairs that weren't written (a failed write, or a
  // pair someone else added meanwhile still counts as reached — harmless).
  const notified = await reconcileNotices(db, noticeRows, planned, addedIds, membersOf, names, now);

  const assigned = results.filter((r) => r.outcome === "assigned");
  const distinct = (k: "students" | "classes" | "teachers") =>
    new Set(assigned.flatMap((r) => addedIds.get(r.testId)?.[k] ?? [])).size;
  const totals: BulkAssignTotals = {
    tests: assigned.length,
    students: distinct("students"),
    classes: distinct("classes"),
    teachers: distinct("teachers"),
    skipped: results.reduce((n, r) => n + r.skipped, 0),
    scheduled: results.flatMap((r) => (r.publishAt ? [r.publishAt] : [])),
    refused: results.filter((r) => r.outcome === "refused").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    added: assigned.reduce((n, r) => n + r.studentsAdded + r.classesAdded + r.teachersAdded, 0),
  };
  return { results, totals, summary: bulkAssignSummary(totals, now), notified };
}

/**
 * After the writes: drop each planned (test, student) pair whose student
 * didn't end up newly assigned (write failed / nothing added). A notice left
 * with no tests is deleted, a changed one rewritten. Never throws; returns
 * how many notices remain.
 */
async function reconcileNotices(
  db: SupabaseClient,
  rows: { id: string; user_id: string }[],
  planned: Map<string, string[]>,
  addedIds: Map<string, { students: string[]; classes: string[] }>,
  membersOf: Map<string, string[]>,
  names: Map<string, string>,
  now: Date,
): Promise<number> {
  if (rows.length === 0) return 0;
  const actual = new Map<string, string[]>();
  for (const [testId, reach] of planned) {
    const a = addedIds.get(testId);
    if (!a) continue;
    const got = new Set([...a.students, ...a.classes.flatMap((c) => membersOf.get(c) ?? [])]);
    actual.set(testId, reach.filter((s) => got.has(s)));
  }
  const want = testsPerStudent(actual);
  const was = testsPerStudent(planned);
  let kept = 0;
  for (const row of rows) {
    const before = was.get(row.user_id) ?? [];
    const after = want.get(row.user_id) ?? [];
    try {
      if (after.length === 0) {
        await db.from("notifications").delete().eq("id", row.id);
      } else {
        kept++;
        if (after.length !== before.length) {
          await db.from("notifications").update({ payload: noticePayload(after, names, now) }).eq("id", row.id);
        }
      }
    } catch (e) {
      console.error("[bulk-assign] notice fix-up failed:", row.id, e instanceof Error ? e.message : e);
    }
  }
  return kept;
}
