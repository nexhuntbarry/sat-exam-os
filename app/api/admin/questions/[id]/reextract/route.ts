import { NextResponse } from "next/server";
import { requireQuestionReviewer } from "@/lib/rbac";
import { reextractQuestionFromPdf } from "@/lib/repair-ops";

// Up to two Claude calls (Sonnet → Opus) on two PDF pages.
export const maxDuration = 60;

// POST /api/admin/questions/[id]/reextract
//
// Read this question again from its source PDF and return the result.
// Read-only: nothing is written; the review page shows it next to the
// stored copy and the reviewer applies what they want, then saves.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireQuestionReviewer();
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;
  try {
    const res = await reextractQuestionFromPdf(id);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  } catch (e) {
    console.error("[questions/reextract] error:", e);
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 },
    );
  }
}
