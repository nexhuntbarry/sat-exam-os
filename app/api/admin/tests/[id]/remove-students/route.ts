import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";

// POST /api/admin/tests/[id]/remove-students
// Body: { studentIds: string[]; deleteSubmissions?: boolean; onlyIfNotStarted?: boolean }
//
// Inverse of add-students: drops the supplied ids from the test's
// `test_assignments.student_ids` so the test disappears from those
// students' dashboards. With `deleteSubmissions`, their submissions for
// this test (and, via ON DELETE CASCADE, the answer_records) go too.
//
// A student can still see the test if one of their class groups is
// assigned to it — those are returned in `stillVisibleViaGroup` so the
// UI can say so instead of claiming the test is gone. Their submissions
// are never deleted: they can keep working on the test, so wiping their
// progress would only lose work.
//
// With `onlyIfNotStarted` (the student page's "Remove assignment"), the
// request is refused (409) if any of the students has a submission for
// this test, so nothing they started is ever unassigned from there.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id: testId } = await params;
  let body: { studentIds?: string[]; deleteSubmissions?: boolean; onlyIfNotStarted?: boolean };
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
  if (body.onlyIfNotStarted) {
    const { count, error: countError } = await db
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("test_id", testId)
      .in("student_id", incoming);
    if (countError) {
      console.error("[remove-students] submission check error:", countError);
      return NextResponse.json({ error: "Failed to remove students" }, { status: 500 });
    }
    if ((count ?? 0) > 0) {
      return NextResponse.json(
        { error: "This student has already started this test, so the assignment can't be removed here." },
        { status: 409 },
      );
    }
  }
  // CAS loop: read current student_ids, compute remaining, write only if unchanged.
  // Also read class_group_ids (needed for stillVisibleViaGroup) on the first pass.
  let actuallyRemoved: string[] = [];
  let cgIds: string[] = [];

  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error: readErr } = await db
      .from("test_assignments")
      .select("student_ids, class_group_ids")
      .eq("test_id", testId)
      .maybeSingle();
    if (readErr) {
      console.error("[remove-students] read error:", readErr);
      return NextResponse.json({ error: "Failed to remove students" }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json({ error: "Test assignment not found" }, { status: 404 });
    }
    const existing: string[] = Array.isArray(row.student_ids) ? (row.student_ids as string[]) : [];
    cgIds = Array.isArray(row.class_group_ids) ? (row.class_group_ids as string[]) : [];
    const removeSet = new Set(incoming);
    const remaining = existing.filter((s) => !removeSet.has(s));
    actuallyRemoved = existing.filter((s) => removeSet.has(s));

    if (actuallyRemoved.length === 0) break; // ids not in list, nothing to remove

    const { data: updated, error: writeErr } = await db
      .from("test_assignments")
      .update({ student_ids: remaining })
      .eq("test_id", testId)
      .filter("student_ids", "eq", JSON.stringify(existing))
      .select("student_ids");
    if (writeErr) {
      console.error("[remove-students] update error:", writeErr);
      return NextResponse.json({ error: "Failed to remove students" }, { status: 500 });
    }
    if ((updated ?? []).length > 0) break; // CAS succeeded
    if (attempt < 4) await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    else return NextResponse.json({ error: "Concurrent update conflict — please retry" }, { status: 409 });
  }

  const removed = actuallyRemoved.length;

  let stillVisibleViaGroup: string[] = [];
  if (cgIds.length > 0) {
    const { data: members, error: membersError } = await db
      .from("class_group_members")
      .select("student_id")
      .in("class_group_id", cgIds)
      .in("student_id", incoming);
    if (membersError) {
      console.error("[remove-students] class group lookup error:", membersError);
      return NextResponse.json({ error: "Failed to remove students" }, { status: 500 });
    }
    stillVisibleViaGroup = Array.from(new Set((members ?? []).map((m) => m.student_id as string)));
  }
  const visibleSet = new Set(stillVisibleViaGroup);
  const deletable = actuallyRemoved.filter((s) => !visibleSet.has(s));

  let deletedSubmissions = 0;
  if (body.deleteSubmissions && deletable.length > 0) {
    const { data: deleted, error: delError } = await db
      .from("submissions")
      .delete()
      .eq("test_id", testId)
      .in("student_id", deletable)
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

  return NextResponse.json({ ok: true, removed, deletedSubmissions, stillVisibleViaGroup });
}
