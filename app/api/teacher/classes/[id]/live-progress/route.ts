import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaClassGroupIds, onSide } from "@/lib/qa";
import { gradebookSubjects, loadClassGradebook } from "@/lib/class-gradebook";
import { loadClassLiveSnapshot } from "@/lib/live-progress";

// GET /api/teacher/classes/[id]/live-progress
// Live progress polled by the class Scores grid on the teacher class page
// (lib/live-progress loadClassLiveSnapshot). Same access as the grid: a
// teacher of this class, limited to their subject; per test, the teacher
// test access rule and full-length section scope apply.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;
  if (!onSide(id, await getQaClassGroupIds(), user.isQa)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = getServiceClient();
  try {
    const access = await gradebookSubjects(db, user, id);
    if (!access) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const gradebook = await loadClassGradebook(db, {
      classGroupId: id,
      isQa: user.isQa,
      subjects: access.subjects,
      testHref: (testId) => `/teacher/tests/${testId}/results`,
    });
    const snapshot = await loadClassLiveSnapshot(db, user, gradebook);
    return NextResponse.json({ data: snapshot }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[teacher/classes/live-progress]", e);
    return NextResponse.json({ error: "Couldn't load live progress" }, { status: 500 });
  }
}
