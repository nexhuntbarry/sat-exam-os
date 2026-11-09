import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { settleQueue } from "@/lib/review-auto";

// Each key change writes one checked explanation (an AI call).
export const maxDuration = 300;

// POST /api/admin/review-queue/auto-settle
// Body: { apply?: boolean, module_id?: string }
//
// "Let the system settle what it can" (lib/review-auto.ts): approve rows that
// pass every check, set keys where both solves agree in a module with no
// answer key (no real student answers), move ownerless Drafts into the queue.
// Without apply it only counts (with the same cap, so the preview matches a
// run). At most 6 key changes per call (time budget).
export async function POST(req: Request) {
  const auth = await requireQuestionReviewer();
  if (auth instanceof NextResponse) return auth;
  const qaBlock = forbidQa(auth);
  if (qaBlock) return qaBlock;
  const body = await req.json().catch(() => ({}));
  const apply = body.apply === true;
  const moduleIds = typeof body.module_id === "string" && body.module_id ? [body.module_id] : undefined;
  try {
    const { outcomes, paused } = await settleQueue(getServiceClient(), {
      apply,
      moduleIds,
      maxKeyChanges: 6,
      deadline: Date.now() + 200_000,
    });
    const counts: Record<string, number> = {};
    for (const o of outcomes) if (o.action !== "none") counts[o.action] = (counts[o.action] ?? 0) + 1;
    const actionable = (counts.approved ?? 0) + (counts.key_set ?? 0) + (counts.to_queue ?? 0);
    return NextResponse.json({ ok: true, apply, paused, counts, actionable, rows: outcomes.filter((o) => o.action !== "none") });
  } catch (e) {
    console.error("[review-queue/auto-settle] error:", e);
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
  }
}
