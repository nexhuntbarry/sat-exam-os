import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { roleError } from "../../../_shared";

// POST /api/admin/tests/[id]/grant-retake
// Body: { studentId: string, notes?: string }
//
// Inserts an unconsumed grant so the student can start one new attempt
// on this test. Idempotent — if a pending grant already exists, returns
// it as-is rather than throwing on the partial unique index.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const grantor = authResult;

  const { id: testId } = await params;
  let body: { studentId?: string; notes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.studentId) {
    return NextResponse.json({ error: "studentId is required" }, { status: 400 });
  }

  const crossSide = await forbidCrossSide(authResult, { testIds: [testId], userIds: [body.studentId] });
  if (crossSide) return crossSide;

  const db = getServiceClient();

  const roleErr = await roleError(db, [body.studentId], "student");
  if (roleErr) return NextResponse.json({ error: roleErr }, { status: 400 });

  // Only students who can actually see the test: individually assigned or
  // a member of an assigned class group.
  const { data: assignment } = await db
    .from("test_assignments")
    .select("student_ids, class_group_ids")
    .eq("test_id", testId)
    .maybeSingle();
  let assigned = ((assignment?.student_ids as string[] | null) ?? []).includes(body.studentId);
  const cgIds = (assignment?.class_group_ids as string[] | null) ?? [];
  if (!assigned && cgIds.length > 0) {
    const { data: member } = await db
      .from("class_group_members")
      .select("student_id")
      .in("class_group_id", cgIds)
      .eq("student_id", body.studentId)
      .limit(1);
    assigned = (member ?? []).length > 0;
  }
  if (!assigned) {
    return NextResponse.json(
      { error: "This student is not assigned to this test" },
      { status: 400 },
    );
  }

  const { data: existing } = await db
    .from("test_retake_grants")
    .select("id")
    .eq("test_id", testId)
    .eq("student_id", body.studentId)
    .is("consumed_at", null)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ ok: true, grantId: existing.id, alreadyPending: true });
  }

  const { data, error } = await db
    .from("test_retake_grants")
    .insert({
      test_id: testId,
      student_id: body.studentId,
      granted_by: grantor.userId,
      notes: body.notes ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[admin/grant-retake]", error);
    return NextResponse.json({ error: "Failed to grant retake" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, grantId: data.id });
}
