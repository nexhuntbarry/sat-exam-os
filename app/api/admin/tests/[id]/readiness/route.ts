import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { loadTestReadiness } from "@/lib/test-readiness";

// GET /api/admin/tests/[id]/readiness — what the Tests list's status menu
// shows before Publish / Close / Back to draft: blockers (the same rules
// the publish and reopen routes enforce), the unassigned warning, who gets
// access, open/due dates, and whether any student has started.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;

  try {
    const readiness = await loadTestReadiness(getServiceClient(), id);
    if (!readiness) return NextResponse.json({ error: "Test not found" }, { status: 404 });
    return NextResponse.json({ data: readiness });
  } catch (err) {
    console.error("[admin/tests/readiness]", err);
    return NextResponse.json({ error: "Could not check the test" }, { status: 500 });
  }
}
