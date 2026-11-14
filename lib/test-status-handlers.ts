// lib/test-status-handlers.ts
//
// Bodies of the test status routes (publish / close / reopen / draft /
// readiness), shared by /api/admin/tests/[id]/* and /api/teacher/tests/[id]/*
// so both sides enforce exactly the same rules (lib/test-readiness,
// moveTestToDraft). Each route only picks its authorizer:
//   - adminTestAuth: admin role + QA side (unchanged admin behaviour);
//   - teacherManagerAuth: approved teacher who manages the test, or admin
//     (lib/test-manage).
import { NextResponse } from "next/server";
import { requireRole } from "./rbac";
import { getServiceClient } from "./supabase";
import { forbidCrossSide, getQaTestIds } from "./qa";
import { blockersMessage, loadPublishCheck, loadTestReadiness, moveTestToDraft } from "./test-readiness";
import { loadManageDecision } from "./test-manage";
import { withQueueInvalidation } from "./review-queue-cache";

/** Returns a 401/403/404/409/500 response to refuse, or null to proceed. */
export type TestAuthorizer = (testId: string) => Promise<NextResponse | null>;

export const adminTestAuth: TestAuthorizer = async (testId) => {
  const user = await requireRole("admin");
  if (user instanceof NextResponse) return user;
  return forbidCrossSide(user, { testIds: [testId] });
};

export const teacherManagerAuth: TestAuthorizer = async (testId) => {
  // requireRole also refuses pending / suspended teachers.
  const user = await requireRole(["teacher", "admin"]);
  if (user instanceof NextResponse) return user;
  let qaTestIds: Set<string>;
  try {
    qaTestIds = await getQaTestIds();
  } catch (err) {
    console.error("[teacher/tests/status] QA lookup", err);
    return NextResponse.json({ error: "Could not verify access to this test" }, { status: 500 });
  }
  const r = await loadManageDecision(getServiceClient(), user, testId, qaTestIds);
  return r.ok ? null : NextResponse.json({ error: r.error }, { status: r.status });
};

/** Draft → Published (publish) or Closed → Published (reopen). */
async function publishTestInner(
  id: string,
  authorize: TestAuthorizer,
  action: "publish" | "reopen",
  tag: string,
): Promise<NextResponse> {
  const denied = await authorize(id);
  if (denied) return denied;
  const db = getServiceClient();

  // Same rules as the Tests list's publish confirm (lib/test-readiness):
  // every module fully approved (students only see Approved questions), a
  // full-length test both two-module sections. Being unassigned is only a
  // warning there, never a refusal here.
  let check;
  try {
    check = await loadPublishCheck(db, id);
  } catch (err) {
    console.error(`[${tag}/${action}] publish check`, err);
    return NextResponse.json({ error: "Could not verify the test" }, { status: 500 });
  }
  if (!check) return NextResponse.json({ error: "Test not found" }, { status: 404 });
  // A full-length SAT section follows its parent (sync trigger).
  if (check.blockers.some((b) => b.code === "fl_section")) {
    return NextResponse.json(
      { error: `This is a section of a full-length SAT — ${action} the full-length test instead.` },
      { status: 409 },
    );
  }
  if (!check.canPublish) {
    return NextResponse.json({ error: blockersMessage(check.blockers), blockers: check.blockers }, { status: 409 });
  }

  const from = action === "publish" ? "Draft" : "Closed";
  const { data, error } = await db
    .from("tests")
    .update({ status: "Published", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", from)
    .select("id");

  if (error) {
    console.error(`[${tag}/${action}]`, error);
    return NextResponse.json({ error: `Failed to ${action} test` }, { status: 500 });
  }
  // The status filter makes a wrong-state call a silent no-op; report it.
  if (!data || data.length === 0) {
    return NextResponse.json(
      {
        error:
          action === "publish"
            ? "Only Draft tests can be published. Refresh to see the current status."
            : "Only Closed tests can be reopened. Refresh to see the current status.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true });
}

/** Published → Closed. Students mid-test can still finish (lib/module2-access). */
async function closeTestInner(id: string, authorize: TestAuthorizer, tag: string): Promise<NextResponse> {
  const denied = await authorize(id);
  if (denied) return denied;
  const db = getServiceClient();

  // A full-length SAT section follows its parent (sync trigger).
  const { data: row, error: rowErr } = await db.from("tests").select("test_kind, parent_test_id").eq("id", id).maybeSingle();
  if (rowErr) {
    console.error(`[${tag}/close] test lookup`, id, rowErr.message);
    return NextResponse.json({ error: "Could not load the test" }, { status: 500 });
  }
  if (!row) return NextResponse.json({ error: "Test not found" }, { status: 404 });
  if (row.parent_test_id || row.test_kind === "fl_section") {
    return NextResponse.json(
      { error: "This is a section of a full-length SAT — close the full-length test instead." },
      { status: 409 },
    );
  }

  const { data, error } = await db
    .from("tests")
    .update({ status: "Closed", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "Published")
    .select("id");

  if (error) {
    console.error(`[${tag}/close]`, error);
    return NextResponse.json({ error: "Failed to close test" }, { status: 500 });
  }
  // The status filter makes a wrong-state call a silent no-op; report it.
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "Only Published tests can be closed. Refresh to see the current status." },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true });
}

/**
 * Published / Closed → Draft, only while no student has started it (no
 * submission, no full-length attempt). Rules and the race handling live in
 * moveTestToDraft (also used by the admin PATCH).
 */
async function draftTestInner(id: string, authorize: TestAuthorizer): Promise<NextResponse> {
  const denied = await authorize(id);
  if (denied) return denied;
  const r = await moveTestToDraft(getServiceClient(), id);
  if (!r.ok) return NextResponse.json({ error: r.error, testStatus: r.testStatus }, { status: r.httpStatus });
  return NextResponse.json({ success: true });
}

/**
 * What the status menu shows before Publish / Close / Back to draft:
 * blockers (the same rules the publish and reopen routes enforce), the
 * unassigned warning, who gets access, open/due dates, and whether any
 * student has started.
 */
export async function testReadiness(id: string, authorize: TestAuthorizer, tag: string): Promise<NextResponse> {
  const denied = await authorize(id);
  if (denied) return denied;
  try {
    const readiness = await loadTestReadiness(getServiceClient(), id);
    if (!readiness) return NextResponse.json({ error: "Test not found" }, { status: 404 });
    return NextResponse.json({ data: readiness });
  } catch (err) {
    console.error(`[${tag}/readiness]`, err);
    return NextResponse.json({ error: "Could not check the test" }, { status: 500 });
  }
}

// Publish / close / reopen / draft change which questions are live: the review
// queue's cached grouping (live labels, live-only filter) is revalidated.
export const publishTest = withQueueInvalidation(publishTestInner);
export const closeTest = withQueueInvalidation(closeTestInner);
export const draftTest = withQueueInvalidation(draftTestInner);
