import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { repairImageForQuestion } from "@/lib/repair-ops";

// POST /api/admin/questions/[id]/repair-image
//
// Re-ask Claude vision for a bounding box for the figure on this
// question's page, then crop + upload the new region. If Claude
// decides there's no figure to extract we clear has_image instead.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;
  try {
    const res = await repairImageForQuestion(id);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  } catch (e) {
    console.error("[questions/repair-image] error:", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  }
}
