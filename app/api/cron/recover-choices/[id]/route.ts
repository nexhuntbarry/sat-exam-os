import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { recoverBrokenChoices } from "@/lib/repair-ops";
import { withQueueInvalidation } from "@/lib/review-queue-cache";

export const maxDuration = 800;

// POST /api/cron/recover-choices/[id]  (Authorization: Bearer <CRON_SECRET>)
// Backfill: re-extract garbled/placeholder/empty choices from the PDF for a
// module's flagged questions. Same logic the parse pipeline runs inline.
async function handlePOST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.get("authorization") || "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const t0 = Date.now();
  const result = await recoverBrokenChoices(id, getServiceClient());
  return NextResponse.json({ ok: true, module_id: id, elapsed_s: Math.round((Date.now() - t0) / 1000), ...result });
}

// The review queue's cached grouping is revalidated after a successful change.
export const POST = withQueueInvalidation(handlePOST);
