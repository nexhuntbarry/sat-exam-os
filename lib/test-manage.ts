// lib/test-manage.ts
//
// Who may change a test's status from the teacher side (Publish / Close /
// Reopen / Back to draft; support 93e0f09e item 5). A teacher manages a
// test only when they are listed directly on it (test_assignments
// .teacher_ids) or created it (tests.created_by). Teaching a class the test
// is assigned to does NOT count: status is test-wide and affects every
// class. Admins manage every test on their side. Pending / suspended
// teachers manage nothing. QA isolation: the test must be on the viewer's
// side. A full-length SAT section is refused: its status follows the parent.
// Kept free of next/server and lib/qa so the unit tests can load it (the
// caller passes the QA test ids).
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ManageUser {
  userId: string;
  role: string | null | undefined;
  accountStatus: string;
  isQa: boolean;
}

export interface ManageTest {
  id: string;
  created_by: string | null;
  parent_test_id: string | null;
  test_kind: string | null;
}

export type ManageResult = { ok: true } | { ok: false; status: 403 | 404 | 409 | 500; error: string };

export const NOT_MANAGER_MESSAGE = "You don't manage this test";
export const FL_SECTION_MESSAGE = "This is a section of a full-length SAT — change the full-length test instead.";

/** Pure rule (unit-tested). `teacherIds` is the union over the test's assignment rows. */
export function manageDecision(input: {
  user: ManageUser;
  test: ManageTest | null;
  teacherIds: readonly unknown[];
  qaTestIds: Set<string>;
}): ManageResult {
  const { user, test } = input;
  if (user.role !== "admin" && user.role !== "teacher") return { ok: false, status: 403, error: "Forbidden" };
  if (user.role === "teacher" && user.accountStatus !== "approved") {
    return { ok: false, status: 403, error: "Account not active" };
  }
  if (!test) return { ok: false, status: 404, error: "Test not found" };
  const crossSide = input.qaTestIds.has(test.id) !== user.isQa;
  const isFlSection = Boolean(test.parent_test_id) || test.test_kind === "fl_section";
  if (user.role === "teacher") {
    // A teacher who doesn't manage the test (or is on the other QA side)
    // gets one plain 403, so its QA side / section status can't be probed.
    const manages = input.teacherIds.includes(user.userId) || test.created_by === user.userId;
    if (!manages || crossSide) return { ok: false, status: 403, error: NOT_MANAGER_MESSAGE };
    if (isFlSection) return { ok: false, status: 409, error: FL_SECTION_MESSAGE };
    return { ok: true };
  }
  if (crossSide) return { ok: false, status: 403, error: "Cannot link QA and real accounts/data" };
  if (isFlSection) return { ok: false, status: 409, error: FL_SECTION_MESSAGE };
  return { ok: true };
}

/** Loads the test and its teacher_ids, then applies manageDecision. Fails closed on a lookup error. */
export async function loadManageDecision(
  db: SupabaseClient,
  user: ManageUser,
  testId: string,
  qaTestIds: Set<string>,
): Promise<ManageResult> {
  const [{ data: test, error: testErr }, { data: asgs, error: asgErr }] = await Promise.all([
    db.from("tests").select("id, created_by, parent_test_id, test_kind").eq("id", testId).maybeSingle(),
    db.from("test_assignments").select("teacher_ids").eq("test_id", testId),
  ]);
  if (testErr || asgErr) {
    console.error("[test-manage] lookup", testId, testErr?.message ?? asgErr?.message);
    return { ok: false, status: 500, error: "Could not verify access to this test" };
  }
  const teacherIds = ((asgs ?? []) as { teacher_ids: unknown }[]).flatMap((a) =>
    Array.isArray(a.teacher_ids) ? a.teacher_ids : [],
  );
  return manageDecision({ user, test: (test as ManageTest | null) ?? null, teacherIds, qaTestIds });
}
