import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { classGroupStudentIds, loadLiveSnapshot } from "@/lib/live-progress";

// GET /api/admin/tests/[id]/live-progress[?class=<class_group_id>]
// Live snapshot polled by the admin Submissions page while students are
// taking the test (lib/live-progress). Same class filter as the page.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(user, { testIds: [id] });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  const classId = new URL(req.url).searchParams.get("class");
  try {
    // An unknown / other-side class is ignored, as on the page.
    const studentIds = classId ? await classGroupStudentIds(db, classId, user.isQa) : null;
    const snapshot = await loadLiveSnapshot(db, { testId: id, viewerIsQa: user.isQa, studentIds });
    return NextResponse.json({ data: snapshot }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[admin/tests/live-progress]", e);
    return NextResponse.json({ error: "Couldn't load live progress" }, { status: 500 });
  }
}
