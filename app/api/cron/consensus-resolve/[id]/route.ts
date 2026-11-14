import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { consensusResolve } from "@/lib/ai/consensus-solve";
import { withQueueInvalidation } from "@/lib/review-queue-cache";

export const maxDuration = 800;

// POST /api/cron/consensus-resolve/[id]  (Authorization: Bearer <CRON_SECRET>)
// For Math modules with no official answer key: solve each flagged question 3x
// independently + verify; auto-approve only unanimous+verified ones.
async function handlePOST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.get("authorization") || "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const t0 = Date.now();
  const result = await consensusResolve(id, getServiceClient());
  return NextResponse.json({ ok: true, module_id: id, elapsed_s: Math.round((Date.now() - t0) / 1000), ...result });
}

// The review queue's cached grouping is revalidated after a successful change.
export const POST = withQueueInvalidation(handlePOST);
