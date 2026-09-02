import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { recoverMissingFigures } from "@/lib/repair-ops";

export const maxDuration = 800;

// POST /api/cron/recover-figures/[id]  (Authorization: Bearer <CRON_SECRET>)
//
// Backfill: for one module, find every Needs-Review question flagged as
// missing a figure and try to recover it (re-read the PDF page, ask Claude
// vision for the figure bbox, crop + upload). Same logic the parse pipeline
// now runs inline (Phase 5b) — exposed here to repair modules parsed before it
// existed. Server-side for reliable Anthropic + PDF access.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.get("authorization") || "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const t0 = Date.now();
  const result = await recoverMissingFigures(id, getServiceClient());
  return NextResponse.json({ ok: true, module_id: id, elapsed_s: Math.round((Date.now() - t0) / 1000), ...result });
}
