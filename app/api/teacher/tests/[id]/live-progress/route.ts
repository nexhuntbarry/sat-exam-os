import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestAccess } from "@/lib/teacher-access";
import { fullLengthLinksOrNone } from "@/lib/full-length";
import { flSectionScope } from "@/lib/full-length-score";
import { loadLiveSnapshot } from "@/lib/live-progress";

// GET /api/teacher/tests/[id]/live-progress
// Live snapshot polled by the teacher test page (lib/live-progress). Same
// access as the page: a class teacher only gets their class's students,
// and on a full-length test only the details of the section they teach.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;
  const db = getServiceClient();
  try {
    const access = await getTeacherTestAccess(db, user, id);
    if (access.mode === null) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const kids = (await fullLengthLinksOrNone(db)).childrenOf.get(id);
    const snapshot = await loadLiveSnapshot(db, {
      testId: id,
      viewerIsQa: user.isQa,
      studentIds: access.mode === "class" ? access.studentAllowlist : null,
      flScope: kids ? await flSectionScope(db, user, kids) : undefined,
    });
    return NextResponse.json({ data: snapshot }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[teacher/tests/live-progress]", e);
    return NextResponse.json({ error: "Couldn't load live progress" }, { status: 500 });
  }
}
