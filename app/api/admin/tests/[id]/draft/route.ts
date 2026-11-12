import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { moveTestToDraft } from "@/lib/test-readiness";

// POST /api/admin/tests/[id]/draft — Published / Closed → Draft, only while
// no student has started it (no submission, no full-length attempt).
// Rules and the race handling live in moveTestToDraft (also used by PATCH).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;

  const r = await moveTestToDraft(getServiceClient(), id);
  if (!r.ok) return NextResponse.json({ error: r.error, testStatus: r.testStatus }, { status: r.httpStatus });
  return NextResponse.json({ success: true });
}
