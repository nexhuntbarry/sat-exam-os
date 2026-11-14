import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { forbidQa } from "@/lib/qa";
import { clearImageFlag } from "@/lib/repair-ops";
import { withQueueInvalidation } from "@/lib/review-queue-cache";

// POST /api/admin/questions/[id]/clear-image-flag
//
// Reviewer-confirmed "no figure needed" toggle. Flips has_image to
// false AND clears image_urls / image_alts so a stale crop doesn't
// keep rendering.
async function handlePOST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const qaBlock = forbidQa(authResult);
  if (qaBlock) return qaBlock;
  const { id } = await params;
  const res = await clearImageFlag(id);
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}

// The review queue's cached grouping is revalidated after a successful change.
export const POST = withQueueInvalidation(handlePOST);
