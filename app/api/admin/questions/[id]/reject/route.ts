import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { withQueueInvalidation } from "@/lib/review-queue-cache";
import { clearFixProposal } from "@/lib/fix-proposal";

// POST /api/admin/questions/[id]/reject
async function handlePOST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const qaBlock = forbidQa(authResult);
  if (qaBlock) return qaBlock;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const reason: string | null = body.reason ?? null;

  const db = getServiceClient();

  const { data, error } = await db
    .from("questions")
    .update({
      parsing_status: "Rejected",
      parsing_notes: reason
        ? `Rejected: ${reason}`
        : "Rejected by admin",
      reviewed_by: authResult.userId,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, parsing_status")
    .single();

  if (error) {
    console.error("[questions/reject] error:", error);
    return NextResponse.json({ error: "Reject failed" }, { status: 500 });
  }
  // A stored fix proposal (review queue "No correct choice") is moot now.
  await clearFixProposal(db, id).catch(() => undefined);

  return NextResponse.json({ data });
}

// The review queue's cached grouping is revalidated after every call.
export const POST = withQueueInvalidation(handlePOST);
