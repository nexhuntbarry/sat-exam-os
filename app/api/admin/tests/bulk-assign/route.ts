import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { roleError } from "../../_shared";
import { withQueueInvalidation } from "@/lib/review-queue-cache";
import { PUBLISH_AT_PENDING_MESSAGE, bulkAssign, publishAtColumnsReady } from "@/lib/test-assign";
import { publishAtError } from "@/lib/test-assign-shared";

// POST /api/admin/tests/bulk-assign  (ticket b271dd38)
// Body: {
//   testIds: string[],                 // 1..100 tests (full-length: the parent)
//   studentIds?: string[], classGroupIds?: string[], teacherIds?: string[],
//   publishAt?: string | null,         // ISO with zone; Drafts publish then
// }
//
// The same additions the single-test Assign dialog makes (compare-and-swap
// adds on test_assignments, lib/test-assign), for every test in one request,
// with one result per test. Already-assigned pairs are skipped, Closed
// tests and full-length sections are refused, and each student gets one
// notification for the whole request. Same admin role and QA-side checks
// as …/[id] PATCH and …/add-students.
//
// Returns { results, totals, summary, notified }. 503 when publishAt is set
// before migration 0034 (database update pending).
const MAX_TESTS = 100;
const MAX_IDS = 500;

function idList(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  return Array.from(new Set(v.filter((s): s is string => typeof s === "string" && s.length > 0)));
}

async function handlePOST(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const admin = authResult;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

  const testIds = idList(body.testIds);
  const studentIds = idList(body.studentIds);
  const classGroupIds = idList(body.classGroupIds);
  const teacherIds = idList(body.teacherIds);
  if (!testIds || !studentIds || !classGroupIds || !teacherIds) return bad("Ids must be arrays of strings");
  if (testIds.length === 0) return bad("Pick at least one test");
  if (testIds.length > MAX_TESTS) return bad(`At most ${MAX_TESTS} tests at a time`);
  if (studentIds.length + classGroupIds.length + teacherIds.length === 0) {
    return bad("Pick at least one student, class or teacher");
  }
  if (studentIds.length > MAX_IDS || classGroupIds.length > MAX_IDS || teacherIds.length > MAX_IDS) {
    return bad(`At most ${MAX_IDS} students, classes or teachers at a time`);
  }

  let publishAt: string | null = null;
  if (body.publishAt !== undefined && body.publishAt !== null && body.publishAt !== "") {
    if (typeof body.publishAt !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/.test(body.publishAt)) {
      return bad("Publish time must be an ISO date/time with a timezone");
    }
    const err = publishAtError(body.publishAt);
    if (err) return bad(err);
    publishAt = new Date(body.publishAt).toISOString();
  }

  const crossSide = await forbidCrossSide(admin, {
    testIds,
    userIds: [...studentIds, ...teacherIds],
    classGroupIds,
  });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  const roleErr = (await roleError(db, studentIds, "student")) ?? (await roleError(db, teacherIds, "teacher"));
  if (roleErr) return bad(roleErr);
  if (classGroupIds.length > 0) {
    const { data, error } = await db.from("class_groups").select("id").in("id", classGroupIds);
    if (error) return bad("Could not verify classes", 500);
    if ((data ?? []).length !== classGroupIds.length) return bad("Some classes no longer exist");
  }

  // Before any write: a publish time needs migration 0034.
  if (publishAt) {
    try {
      if (!(await publishAtColumnsReady(db))) return bad(PUBLISH_AT_PENDING_MESSAGE, 503);
    } catch (e) {
      console.error("[admin/tests/bulk-assign] publish_at probe", e);
      return bad("Could not check the database", 500);
    }
  }

  try {
    const out = await bulkAssign(db, { testIds, studentIds, classGroupIds, teacherIds, publishAt });
    console.info(
      `[admin/tests/bulk-assign] by ${admin.userId}: ${out.summary}`,
      out.results.map((r) => `${r.testId}:${r.outcome}${r.error ? ` (${r.error})` : ""}`).join(", "),
    );
    return NextResponse.json(out);
  } catch (e) {
    console.error("[admin/tests/bulk-assign]", e);
    return bad("Failed to assign tests", 500);
  }
}

// Same as the single-test assignment routes: the review queue's cached
// grouping is revalidated after every call.
export const POST = withQueueInvalidation(handlePOST);
