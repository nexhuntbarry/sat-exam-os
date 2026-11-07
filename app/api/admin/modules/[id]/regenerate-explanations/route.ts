import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { listCutOffExplanations, regenerateCutOffExplanationsBatch } from "@/lib/ai/solve-question";

// One batch = up to BATCH questions, 4 at a time, each up to two Claude calls.
export const maxDuration = 300;
const BATCH = 8;

// POST /api/admin/modules/[id]/regenerate-explanations
//   {}                       → { targets: [{ id, number }] } (cut-off explanations; nothing written)
//   { question_ids: [...] }  → regenerate those (≤ 8 per call) → { results }
// The page calls it in batches to stay inside the function time limit.
// Writes only the explanation + a review note; never the answer, never
// approves (see regenerateCutOffExplanationsBatch for the live-test rule).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const qaBlock = forbidQa(authResult);
  if (qaBlock) return qaBlock;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const db = getServiceClient();

  try {
    if (!Array.isArray(body.question_ids)) {
      const targets = await listCutOffExplanations(id, db);
      return NextResponse.json({ targets, batch: BATCH });
    }
    const ids = (body.question_ids as unknown[]).filter((x): x is string => typeof x === "string");
    if (ids.length === 0 || ids.length > BATCH) {
      return NextResponse.json({ error: `Send 1–${BATCH} question_ids per call` }, { status: 400 });
    }
    const results = await regenerateCutOffExplanationsBatch(id, ids, db, authResult.userId);
    return NextResponse.json({ results });
  } catch (e) {
    console.error("[modules/regenerate-explanations] error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
