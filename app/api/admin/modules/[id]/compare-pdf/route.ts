import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { comparePendingQuestions, pdfCheckCounts, ReplacePdfError } from "@/lib/pdf-replace";

export const maxDuration = 300;

// GET /api/admin/modules/[id]/compare-pdf — { pending, match, diff } counts.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  return NextResponse.json(await pdfCheckCounts(getServiceClient(), id));
}

// POST /api/admin/modules/[id]/compare-pdf
// One batch: compares the module's "[pdf-pending]" questions with its source
// PDF for up to ~200s (headroom under maxDuration), tagging each
// "[pdf-match]" or "[pdf-diff] …". Returns { checked, matched, differs,
// remaining }; the caller repeats while remaining > 0. Never approves.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const qaBlock = forbidQa(auth);
  if (qaBlock) return qaBlock;

  const { id } = await params;
  try {
    const summary = await comparePendingQuestions(getServiceClient(), id);
    console.log(`[modules/compare-pdf] module=${id} ${JSON.stringify(summary)}`);
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    if (err instanceof ReplacePdfError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[modules/compare-pdf] error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Compare failed" }, { status: 500 });
  }
}
