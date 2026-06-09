import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { clearImageFlag } from "@/lib/repair-ops";

// POST /api/admin/questions/[id]/clear-image-flag
//
// Reviewer-confirmed "no figure needed" toggle. Flips has_image to
// false AND clears image_urls / image_alts so a stale crop doesn't
// keep rendering.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;
  const res = await clearImageFlag(id);
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
