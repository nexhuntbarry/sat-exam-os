import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { approveBlockedMessage, findApproveBlocker } from "@/lib/parse-guards";
import { clearReviewTags, hasReviewTags } from "@/lib/key-doubt";

// POST /api/admin/questions/[id]/approve
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const qaBlock = forbidQa(authResult);
  if (qaBlock) return qaBlock;

  const { id } = await params;
  const db = getServiceClient();

  const { data: current } = await db
    .from("questions")
    .select("question_text, choices, question_type, correct_answer, official_answer, parsing_notes")
    .eq("id", id)
    .maybeSingle();
  const blocker = current
    ? findApproveBlocker(current.question_text, current.choices, current.question_type, current.correct_answer ?? null, current.official_answer ?? null)
    : null;
  if (blocker) {
    return NextResponse.json({ error: approveBlockedMessage(blocker) }, { status: 400 });
  }

  const update: Record<string, unknown> = {
    parsing_status: "Approved",
    reviewed_by: authResult.userId,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // A person approving it clears the live-test re-check tag and any
  // "AI thinks the answer key may be wrong" doubt.
  if (hasReviewTags(current?.parsing_notes)) {
    update.parsing_notes = clearReviewTags(current?.parsing_notes);
  }

  const { data, error } = await db
    .from("questions")
    .update(update)
    .eq("id", id)
    .select("id, parsing_status")
    .single();

  if (error) {
    console.error("[questions/approve] error:", error);
    return NextResponse.json({ error: "Approve failed" }, { status: 500 });
  }

  return NextResponse.json({ data });
}
