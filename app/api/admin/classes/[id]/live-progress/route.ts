import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaClassGroupIds, onSide } from "@/lib/qa";
import { loadClassGradebookFrame } from "@/lib/class-gradebook";
import { loadClassLiveSnapshot } from "@/lib/live-progress";

// GET /api/admin/classes/[id]/live-progress
// Live progress polled by the class Scores grid while a cell is in
// progress: every unfinished cell of the class's tests in one response
// (lib/live-progress loadClassLiveSnapshot), keyed by test + student.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;
  if (!onSide(id, await getQaClassGroupIds(), user.isQa)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = getServiceClient();
  try {
    // The grid's frame only (members, assigned tests): no full gradebook per poll.
    const frame = await loadClassGradebookFrame(db, { classGroupId: id, isQa: user.isQa, subjects: null });
    const snapshot = await loadClassLiveSnapshot(db, user, {
      testIds: frame.tests.map((t) => t.id),
      studentIds: frame.students.map((s) => s.id),
      scope: frame.scope,
      links: frame.links,
    });
    return NextResponse.json({ data: snapshot }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[admin/classes/live-progress]", e);
    return NextResponse.json({ error: "Couldn't load live progress" }, { status: 500 });
  }
}
