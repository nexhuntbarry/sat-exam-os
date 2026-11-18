import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { withQueueInvalidation } from "@/lib/review-queue-cache";
import { clearFixProposal } from "@/lib/fix-proposal";
import { liveQuestionIds } from "@/lib/live-questions";
import { splitLiveFixNote } from "@/lib/review-queue";

// POST /api/admin/questions/[id]/reject
// Refused (409) for a question in a live test: rejecting it would pull it
// out of a running exam. A failed live lookup refuses too.
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

  const { data: prior } = await db.from("questions").select("id, parsing_notes").eq("id", id).maybeSingle();
  if (!prior) return NextResponse.json({ error: "Question not found" }, { status: 404 });
  const live = await liveQuestionIds(db, [id]).catch(() => null);
  if (!live || live.has(id)) {
    return NextResponse.json(
      { error: live ? "This question is in a live test, so it can't be rejected. Fix it instead." : "Couldn't check whether this question is in a live test. Try again." },
      { status: 409 },
    );
  }

  // A leading [live-fix] re-check sentence stays in front.
  const { head } = splitLiveFixNote(prior.parsing_notes as string | null);
  const rejected = reason ? `Rejected: ${reason}` : "Rejected by admin";
  const { data, error } = await db
    .from("questions")
    .update({
      parsing_status: "Rejected",
      parsing_notes: head ? `${head} ${rejected}` : rejected,
      reviewed_by: authResult.userId,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, parsing_status")
    .single();

  if (error || !data) {
    console.error("[questions/reject] error:", error);
    return NextResponse.json({ error: "Reject failed" }, { status: 500 });
  }
  // Only after the reject went through: a stored fix proposal is moot now.
  await clearFixProposal(db, id).catch(() => undefined);

  return NextResponse.json({ data });
}

// The review queue's cached grouping is revalidated after every call.
export const POST = withQueueInvalidation(handlePOST);
