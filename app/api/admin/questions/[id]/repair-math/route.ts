import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { repairMathForQuestion } from "@/lib/repair-ops";

// Up to three sequential Claude calls (Haiku → Sonnet → Opus) on a
// PDF page can take 60+ seconds combined. The default 10s ceiling
// would silently abort. 60 is the Vercel Pro cap; 90+ needs the
// Enterprise plan.
export const maxDuration = 60;

// POST /api/admin/questions/[id]/repair-math
//
// Re-extract this single question's text / choices / explanation
// via Claude with the consolidated formatting rules. Mirrors what
// scripts/repair-math-render-failed.ts does for one row.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;
  try {
    const res = await repairMathForQuestion(id);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  } catch (e) {
    console.error("[questions/repair-math] error:", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  }
}
