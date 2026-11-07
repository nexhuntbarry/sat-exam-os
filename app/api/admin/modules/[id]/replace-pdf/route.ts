import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidQa } from "@/lib/qa";
import { replaceModulePdf, ReplacePdfError } from "@/lib/pdf-replace";

export const maxDuration = 60;

// POST /api/admin/modules/[id]/replace-pdf  { pdfUrl }
// Attach a newly uploaded PDF (client upload to Blob under modules/, same as
// module creation) to this module WITHOUT re-parsing. Backs up the new and
// old PDF, repoints modules.pdf_url + questions.source_pdf_url and tags each
// question "[pdf-pending]". Questions, answers, keys and scores are kept.
// The client then drives POST ./compare-pdf until nothing is pending.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const qaBlock = forbidQa(auth);
  if (qaBlock) return qaBlock;

  const { id } = await params;
  let body: { pdfUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.pdfUrl) return NextResponse.json({ error: "pdfUrl is required" }, { status: 400 });

  try {
    const result = await replaceModulePdf(getServiceClient(), id, body.pdfUrl);
    console.log(
      `[modules/replace-pdf] module=${id} by=${auth.userId} questions=${result.questions} backups=${result.backups.length}${result.backupWarnings.length ? ` warnings=${result.backupWarnings.join(" | ")}` : ""}`,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ReplacePdfError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[modules/replace-pdf] error:", err);
    return NextResponse.json({ error: "Replace failed" }, { status: 500 });
  }
}
