import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";

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

  // In Progress submissions for the given students in those tests
  const { data: subs, error: sErr } = await db
    .from("submissions")
    .select("test_id, student_id")
    .in("test_id", testIds)
    .in("student_id", studentIds)
    .eq("status", "In Progress");

  if (sErr) return NextResponse.json({ error: "DB error" }, { status: 500 });

  // Count per test
  const countByTest = new Map<string, number>();
  for (const s of subs ?? []) {
    const tid = s.test_id as string;
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
