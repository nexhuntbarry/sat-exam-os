import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { findApproveBlocker } from "@/lib/parse-guards";

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
    .select("question_text, choices, question_type")
    .eq("id", id)
    .maybeSingle();
  const blocker = current ? findApproveBlocker(current.question_text, current.choices, current.question_type) : null;
  if (blocker) {
    return NextResponse.json({ error: `Can't approve: ${blocker.reason}. Fix the text first.` }, { status: 400 });
  }

  const { data, error } = await db
    .from("questions")
    .update({
      parsing_status: "Approved",
      reviewed_by: authResult.userId,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, parsing_status")
    .single();

  if (error) {
    console.error("[questions/approve] error:", error);
    return NextResponse.json({ error: "Approve failed" }, { status: 500 });
  }

  return NextResponse.json({ data });
}
