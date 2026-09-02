import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { consensusResolve } from "@/lib/ai/consensus-solve";

export const maxDuration = 800;

// POST /api/cron/consensus-resolve/[id]  (Authorization: Bearer <CRON_SECRET>)
// For Math modules with no official answer key: solve each flagged question 3x
// independently + verify; auto-approve only unanimous+verified ones.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.get("authorization") || "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const t0 = Date.now();
  const result = await consensusResolve(id, getServiceClient());
  return NextResponse.json({ ok: true, module_id: id, elapsed_s: Math.round((Date.now() - t0) / 1000), ...result });
}
