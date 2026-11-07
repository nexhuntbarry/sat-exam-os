// scripts/test-unassign-access.ts
//
// Verifies the unassign-access rules introduced in lib/module2-access.ts:
//   - A student with an In Progress submission may still access the test
//     page (resume) even after being unassigned from the test.
//   - That same student cannot start a NEW attempt after being unassigned.
//
// Uses QA student 093 and the mathLinear QA test so it won't touch real data.
// Cleans up all created rows at the end.
//
//   npx tsx --env-file=.env.local scripts/test-unassign-access.ts

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { studentTestAccess } from "../lib/module2-access";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const cast = JSON.parse(readFileSync(".omc/qa/cast.json", "utf-8"));
const TESTS = JSON.parse(readFileSync(".omc/qa/tests.json", "utf-8")) as Record<string, string>;

const student = (n: number) => {
  const s = cast.students.find((x: { name: string }) => x.name === `TEST Student ${String(n).padStart(3, "0")}`);
  if (!s) throw new Error(`QA student ${n} missing`);
  return s.id as string;
};

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

async function assertQa(studentId: string) {
  const { data } = await db.from("users").select("email").eq("id", studentId).single();
  if (!data?.email?.startsWith("qa-test-")) throw new Error(`refusing to touch non-QA user ${studentId}`);
}

async function clear(studentId: string, testId: string) {
  await assertQa(studentId);
  const { data: subs } = await db.from("submissions").select("id").eq("student_id", studentId).eq("test_id", testId);
  const ids = (subs ?? []).map((r) => r.id as string);
  if (ids.length) {
    await db.from("answer_records").delete().in("submission_id", ids);
    await db.from("submissions").delete().in("id", ids);
  }
}

async function removeFromAssignment(studentId: string, testId: string) {
  const { data: row } = await db.from("test_assignments").select("student_ids").eq("test_id", testId).single();
  if (!row) return;
  const existing = (row.student_ids as string[]) ?? [];
  await db.from("test_assignments").update({ student_ids: existing.filter((s) => s !== studentId) }).eq("test_id", testId);
}

async function addToAssignment(studentId: string, testId: string) {
  const { data: row } = await db.from("test_assignments").select("student_ids").eq("test_id", testId).single();
  if (!row) return;
  const existing = (row.student_ids as string[]) ?? [];
  if (!existing.includes(studentId)) {
    await db.from("test_assignments").update({ student_ids: [...existing, studentId] }).eq("test_id", testId);
  }
}

/**
 * Returns the class-group IDs that (a) the student belongs to AND (b) the test
 * currently has in class_group_ids — these make the student "assigned via class".
 */
async function getStudentClassGroupsForTest(studentId: string, testId: string): Promise<string[]> {
  const [{ data: memberships }, { data: ta }] = await Promise.all([
    db.from("class_group_members").select("class_group_id").eq("student_id", studentId),
    db.from("test_assignments").select("class_group_ids").eq("test_id", testId).single(),
  ]);
  const studentCgIds = new Set((memberships ?? []).map((m) => m.class_group_id as string));
  const testCgIds: string[] = (ta?.class_group_ids as string[]) ?? [];
  return testCgIds.filter((id) => studentCgIds.has(id));
}

/** Temporarily remove class groups from the test's class_group_ids. */
async function removeClassGroupsFromTest(cgIds: string[], testId: string) {
  if (cgIds.length === 0) return;
  const { data: ta } = await db.from("test_assignments").select("class_group_ids").eq("test_id", testId).single();
  const existing: string[] = (ta?.class_group_ids as string[]) ?? [];
  const toRemove = new Set(cgIds);
  await db.from("test_assignments").update({ class_group_ids: existing.filter((id) => !toRemove.has(id)) }).eq("test_id", testId);
}

/** Restore class groups to the test's class_group_ids. */
async function restoreClassGroupsToTest(cgIds: string[], testId: string) {
  if (cgIds.length === 0) return;
  const { data: ta } = await db.from("test_assignments").select("class_group_ids").eq("test_id", testId).single();
  const existing: string[] = (ta?.class_group_ids as string[]) ?? [];
  const merged = [...new Set([...existing, ...cgIds])];
  await db.from("test_assignments").update({ class_group_ids: merged }).eq("test_id", testId);
}

async function createInProgressSubmission(studentId: string, testId: string): Promise<string> {
  const { data, error } = await db
    .from("submissions")
    .insert({
      test_id: testId,
      student_id: studentId,
      status: "In Progress",
      attempt_number: 1,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to create submission: ${error?.message}`);
  return data.id as string;
}

const STUDENT_ID = student(93);
const TEST_ID = TESTS.mathLinear;
const TEST_OBJ = { id: TEST_ID, status: "Published" };
const USER = { userId: STUDENT_ID, isQa: true };

async function main() {
  console.log(`\nTest: unassign-access  student=${STUDENT_ID.slice(0, 8)}  test=${TEST_ID.slice(0, 8)}\n`);

  // Find class groups that make this student "assigned via class" for this test.
  // We temporarily remove them so we can test unassigned state cleanly.
  const savedClassGroupIds = await getStudentClassGroupsForTest(STUDENT_ID, TEST_ID);
  console.log(`  student's overlapping class groups: [${savedClassGroupIds.map((id) => id.slice(0, 8)).join(", ")}]`);

  try {
    await assertQa(STUDENT_ID);

    // ── Setup: fully unassign the student (student_ids + class group overlap) ─
    await clear(STUDENT_ID, TEST_ID);
    await removeFromAssignment(STUDENT_ID, TEST_ID);
    await removeClassGroupsFromTest(savedClassGroupIds, TEST_ID);

    // UA-01: Unassigned, no submission → 403
    {
      const access = await studentTestAccess(db, USER, TEST_OBJ);
      check("UA-01 unassigned + no submission → 403", access.error?.status === 403, { error: access.error });
    }

    // UA-02: Assigned (via student_ids), no submission → allowed, assigned=true
    await addToAssignment(STUDENT_ID, TEST_ID);
    {
      const access = await studentTestAccess(db, USER, TEST_OBJ);
      check("UA-02 assigned + no submission → error=null, assigned=true", access.error === null && access.assigned === true);
    }

    // UA-03: Create In Progress submission, then unassign → still allowed, assigned=false
    const subId = await createInProgressSubmission(STUDENT_ID, TEST_ID);
    await removeFromAssignment(STUDENT_ID, TEST_ID);
    {
      const access = await studentTestAccess(db, USER, TEST_OBJ);
      check(
        "UA-03 unassigned + in-progress → error=null, assigned=false",
        access.error === null && access.assigned === false,
        { error: access.error, assigned: access.assigned },
      );
    }

    // UA-04: assigned=false means cannot start new attempt
    {
      const access = await studentTestAccess(db, USER, TEST_OBJ);
      check("UA-04 assigned=false means cannot start new attempt", access.assigned === false);
    }

    // UA-05: Once submission is Submitted (no in-progress), not assigned → 403
    await db.from("submissions").update({ status: "Submitted", submitted_at: new Date().toISOString() }).eq("id", subId);
    {
      const access = await studentTestAccess(db, USER, TEST_OBJ);
      check(
        "UA-05 unassigned + submitted (no in-progress) → 403",
        access.error?.status === 403,
        { error: access.error },
      );
    }

    // UA-06: Re-assign → allowed, assigned=true again
    await addToAssignment(STUDENT_ID, TEST_ID);
    {
      const access = await studentTestAccess(db, USER, TEST_OBJ);
      check("UA-06 re-assigned → error=null, assigned=true", access.error === null && access.assigned === true);
    }

  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────
    await clear(STUDENT_ID, TEST_ID);
    await removeFromAssignment(STUDENT_ID, TEST_ID);
    await restoreClassGroupsToTest(savedClassGroupIds, TEST_ID);
    console.log("\nCleanup done");
  }

  console.log(`\n${failures === 0 ? "All tests passed" : `${failures} test(s) FAILED`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
