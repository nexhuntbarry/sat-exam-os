import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { repairTableForQuestion } from "@/lib/repair-ops";

// Re-reads the source PDF (Sonnet → Opus) to rebuild a flattened data
// table as a Markdown table — same 60s ceiling as the other repair ops.
export const maxDuration = 60;

// POST /api/admin/questions/[id]/repair-table
//
// Rebuild this question's flattened data table as a GFM Markdown table
// inside question_text (the renderer already supports remark-gfm) and
// clear has_table. Mirrors repairMathForQuestion for one row.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;
  try {
    const res = await repairTableForQuestion(id);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  } catch (e) {
    console.error("[questions/repair-table] error:", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  }
}
