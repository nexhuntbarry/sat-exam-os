import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { extractAnswerKey, fetchPdfAsBase64 } from "@/lib/ai/parse-pdf";

// Vercel Hobby caps Serverless Functions at 300s; this probe usually
// finishes in <30s but headroom matters when PDFs are large.
export const maxDuration = 60;

// POST /api/admin/modules/[id]/probe-answer-key
//
// Reads the PDF's last 1-3 pages with Claude Haiku 4.5 and returns the
// answer key if one is present. Cheap pre-parse step so the admin can
// confirm whether to proceed with comparison parsing or fall back to
// AI-only parsing (no ground truth).
//
// Response shape:
//   { found: boolean, count: number, answers: { [num]: string }, notes?: string }
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data: mod, error: fetchError } = await db
    .from("modules")
    .select("id, pdf_url")
    .eq("id", id)
    .single();

  if (fetchError || !mod) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  let pdfBase64: string;
  try {
    pdfBase64 = await fetchPdfAsBase64(mod.pdf_url);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[probe-answer-key] PDF fetch failed:", err);
    return NextResponse.json(
      { error: "PDF fetch failed", detail: errorMsg },
      { status: 500 },
    );
  }

  try {
    const key = await extractAnswerKey(pdfBase64, authResult.userId);
    return NextResponse.json({
      found: key.found,
      count: Object.keys(key.answers).length,
      answers: key.answers,
      notes: key.notes,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[probe-answer-key] extractor error:", err);
    return NextResponse.json(
      { error: "Answer-key extraction failed", detail: errorMsg },
      { status: 500 },
    );
  }
}
