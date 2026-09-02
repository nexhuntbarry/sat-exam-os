import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { runSemanticAudit } from "@/lib/ai/semantic-audit";

export const maxDuration = 300;

// POST /api/admin/modules/[id]/run-audit
// Re-runs the Phase 5 semantic content audit on every question in a module
// without re-parsing. Used to sweep modules that were parsed before the audit
// pass existed — flags corrupted math, missing figures, and answer/explanation
// mismatches, demoting them to Needs Review so an admin can fix them.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const db = getServiceClient();

  const t0 = Date.now();
  const summary = await runSemanticAudit(id, db, auth.userId);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  return NextResponse.json({
    ok: true,
    elapsed_s: parseFloat(elapsed),
    ...summary,
  });
}
