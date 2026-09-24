import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { regenerateTruncatedExplanations } from "@/lib/ai/solve-question";
import { recoverMissingFigures, recoverBrokenChoices } from "@/lib/repair-ops";
import { enforceCompleteness, checkNumberContiguity } from "@/lib/parse-guards";
import { runSemanticAudit } from "@/lib/ai/semantic-audit";

export const maxDuration = 800;

// POST /api/cron/harden/[id]  (Authorization: Bearer <CRON_SECRET>)
// Applies the parsing guards to an EXISTING module without a full re-parse:
// regenerate truncated explanations, recover stem-referenced/blind figures,
// recover broken choices, re-audit, enforce completeness, check contiguity.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.get("authorization") || "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const db = getServiceClient();
  const t0 = Date.now();
  const out: Record<string, unknown> = {};
  try { out.truncation = await regenerateTruncatedExplanations(id, db); } catch (e) { out.truncation = { error: String(e) }; }
  try { out.figures = await recoverMissingFigures(id, db); } catch (e) { out.figures = { error: String(e) }; }
  try { out.choices = await recoverBrokenChoices(id, db); } catch (e) { out.choices = { error: String(e) }; }
  try { out.audit = await runSemanticAudit(id, db); } catch (e) { out.audit = { error: String(e) }; }
  try { out.completeness = await enforceCompleteness(id, db); } catch (e) { out.completeness = { error: String(e) }; }
  try { out.contiguity = await checkNumberContiguity(id, db); } catch (e) { out.contiguity = { error: String(e) }; }
  return NextResponse.json({ ok: true, module_id: id, elapsed_s: Math.round((Date.now() - t0) / 1000), ...out });
}
