import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { asParentRows, expandWithChildren, fullLengthLinks } from "@/lib/full-length";

// POST /api/admin/class-groups/[id]/in-progress-check
// Body: { studentIds: string[] }
//
// Returns the tests assigned via this class group that have at least one
// of the given students with an In Progress submission.  Used by the
// Students-page "Remove from class" modal to warn admins before removing.
// POST body avoids URL length limits for large student lists.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id: cgId } = await params;
  let body: { studentIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const studentIds = Array.isArray(body.studentIds)
    ? (body.studentIds as unknown[])
        .filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];

  if (studentIds.length === 0) return NextResponse.json({ tests: [] });

  // QA side isolation
  const crossSide = await forbidCrossSide(authResult, {
    classGroupIds: [cgId],
    userIds: studentIds,
  });
  if (crossSide) return crossSide;

  const db = getServiceClient();

  // Tests that list this class group in class_group_ids
  const { data: assignments, error: aErr } = await db
    .from("test_assignments")
    .select("test_id, tests(id, test_name)")
    .contains("class_group_ids", JSON.stringify([cgId]));

  if (aErr) return NextResponse.json({ error: "DB error" }, { status: 500 });
  if (!assignments || assignments.length === 0) return NextResponse.json({ tests: [] });

  const testIds = assignments.map((a) => a.test_id as string);

  // In Progress submissions for the given students in those tests. A
  // full-length SAT's rows are on its section children; an attempt whose
  // Math isn't finished (on the break included) counts once, as in progress.
  const flLinks = await fullLengthLinks(db);
  const flParents = testIds.filter((id) => flLinks.childrenOf.has(id));
  const { data: subs, error: sErr } = await db
    .from("submissions")
    .select("test_id, student_id, status, attempt_number, adaptive_track")
    .in("test_id", expandWithChildren(testIds, flLinks))
    .in("student_id", studentIds)
    .in("status", flParents.length > 0 ? ["In Progress", "Submitted", "Late"] : ["In Progress"]);

  if (sErr) return NextResponse.json({ error: "DB error" }, { status: 500 });

  // Count per test (one per full-length attempt)
  const countByTest = new Map<string, number>();
  const seenAttempt = new Set<string>();
  for (const s of asParentRows(subs ?? [], flLinks)) {
    if (s.status !== "In Progress") continue;
    const tid = s.test_id as string;
    if (flLinks.childrenOf.has(tid)) {
      const k = `${tid}:${s.student_id}:${s.attempt_number ?? 1}`;
      if (seenAttempt.has(k)) continue;
      seenAttempt.add(k);
    }
    countByTest.set(tid, (countByTest.get(tid) ?? 0) + 1);
  }

  const tests = assignments
    .map((a) => {
      const t = Array.isArray(a.tests) ? a.tests[0] : a.tests;
      return {
        id: a.test_id as string,
        name: ((t as { test_name?: string } | null)?.test_name) ?? "Untitled test",
        inProgressCount: countByTest.get(a.test_id as string) ?? 0,
      };
    })
    .filter((t) => t.inProgressCount > 0);

  return NextResponse.json({ tests });
}
