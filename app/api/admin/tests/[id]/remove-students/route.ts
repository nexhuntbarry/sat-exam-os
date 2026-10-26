import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";

// POST /api/admin/tests/[id]/remove-students
// Body: { studentIds: string[]; deleteSubmissions?: boolean }
//
// Inverse of add-students: drops the supplied ids from the test's
// `test_assignments.student_ids` so the test disappears from those
// students' dashboards. With `deleteSubmissions`, their submissions for
// this test (and, via ON DELETE CASCADE, the answer_records) go too.
//
// A student can still see the test if one of their class groups is
// assigned to it — those are returned in `stillVisibleViaGroup` so the
// UI can say so instead of claiming the test is gone.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id: testId } = await params;
  let body: { studentIds?: string[]; deleteSubmissions?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const incoming = Array.isArray(body.studentIds)
    ? body.studentIds.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  if (incoming.length === 0) {
    return NextResponse.json({ error: "studentIds is required" }, { status: 400 });
  }

  const crossSide = await forbidCrossSide(authResult, { testIds: [testId] });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  const { data: assignment } = await db
    .from("test_assignments")
    .select("id, student_ids, class_group_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) {
    return NextResponse.json({ error: "Test assignment not found" }, { status: 404 });
  }

  const existing: string[] = (assignment.student_ids as string[]) ?? [];
  const removeSet = new Set(incoming);
  const remaining = existing.filter((s) => !removeSet.has(s));
  // Only ids that were actually individually assigned — never delete work
  // for a student who reaches this test some other way (class group).
  const actuallyRemoved = existing.filter((s) => removeSet.has(s));
  const removed = actuallyRemoved.length;

  const { error } = await db
    .from("test_assignments")
    .update({ student_ids: remaining })
    .eq("id", assignment.id);

  if (error) {
    console.error("[remove-students] update error:", error);
    return NextResponse.json({ error: "Failed to remove students" }, { status: 500 });
  }

  let deletedSubmissions = 0;
  if (body.deleteSubmissions && actuallyRemoved.length > 0) {
    const { data: deleted, error: delError } = await db
      .from("submissions")
      .delete()
      .eq("test_id", testId)
      .in("student_id", actuallyRemoved)
      .select("id");
    if (delError) {
      console.error("[remove-students] submission delete error:", delError);
      return NextResponse.json(
        { error: "Students removed, but deleting their submissions failed" },
        { status: 500 },
      );
    }
    deletedSubmissions = deleted?.length ?? 0;
  }

  const cgIds: string[] = (assignment.class_group_ids as string[]) ?? [];
  let stillVisibleViaGroup: string[] = [];
  if (cgIds.length > 0) {
    const { data: members } = await db
      .from("class_group_members")
      .select("student_id")
      .in("class_group_id", cgIds)
      .in("student_id", incoming);
    stillVisibleViaGroup = Array.from(new Set((members ?? []).map((m) => m.student_id as string)));
  }

  return NextResponse.json({ ok: true, removed, deletedSubmissions, stillVisibleViaGroup });
}
