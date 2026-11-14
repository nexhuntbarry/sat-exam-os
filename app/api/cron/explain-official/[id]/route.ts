import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { explainOfficialAndPersist } from "@/lib/ai/solve-question";
import { withQueueInvalidation } from "@/lib/review-queue-cache";

export const maxDuration = 800;

// POST /api/cron/explain-official/[id]  (Authorization: Bearer <CRON_SECRET>)
//
// Backfill endpoint: for a module whose answers are trusted (set from the
// official answer key), regenerate every question's explanation so it
// justifies that official answer, and Approve the ones with no other defect.
// Same logic the parse pipeline now runs inline (Phase 4b) — exposed here to
// repair modules parsed before that phase existed. Runs server-side (reliable
// Anthropic access) rather than from a flaky local script.
async function handlePOST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.get("authorization") || "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const t0 = Date.now();
  const result = await explainOfficialAndPersist(id, getServiceClient());
  return NextResponse.json({ ok: true, module_id: id, elapsed_s: Math.round((Date.now() - t0) / 1000), ...result });
}

// The review queue's cached grouping is revalidated after every call.
export const POST = withQueueInvalidation(handlePOST);
