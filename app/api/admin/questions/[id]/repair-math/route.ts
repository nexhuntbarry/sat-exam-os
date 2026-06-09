import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { repairMathForQuestion } from "@/lib/repair-ops";

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
