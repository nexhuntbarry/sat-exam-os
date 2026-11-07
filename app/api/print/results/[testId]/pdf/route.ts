import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { loadResultPrintouts, parsePrintOptions, printoutFileName, PrintAccessError } from "@/lib/result-printout";
import { mintPrintTicket } from "@/lib/print-token";
import { PdfBusyError, PdfRenderError, renderPrintPdf } from "@/lib/render-pdf";

export const runtime = "nodejs";
// One student per request (the bulk download calls this once per student
// with progress), so a class never runs into a single long request.
export const maxDuration = 60;

// GET /api/print/results/<testId>/pdf?sub=<submissionId>&mode=full|short&expl=1&at=inline|end
// The student's printed result as a PDF file — the same paginated document
// as the /print/results preview, rendered by headless Chromium.
export async function GET(req: Request, { params }: { params: Promise<{ testId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { testId } = await params;
  const sp = new URL(req.url).searchParams;
  const sub = sp.get("sub");
  if (!sub) return NextResponse.json({ error: "Missing sub" }, { status: 400 });
  const opts = parsePrintOptions({ mode: sp.get("mode") ?? undefined, expl: sp.get("expl") ?? undefined, at: sp.get("at") ?? undefined });
  const viewer = { userId: user.userId, role: user.role, isQa: user.isQa };

  // Access check up front (the print page checks again with the ticket).
  let name: string;
  try {
    const [p] = await loadResultPrintouts(getServiceClient(), viewer, testId, [sub], { ...opts, summaryOnly: true });
    if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 });
    name = printoutFileName(p);
  } catch (e) {
    if (e instanceof PrintAccessError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  try {
    const ticket = mintPrintTicket({ viewer, testId, subs: [sub], opts });
    const url = `${new URL(req.url).origin}/print/results/${testId}?pt=${encodeURIComponent(ticket)}`;
    const { pdf, pages } = await renderPrintPdf(url);
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "private, no-store",
        "X-Print-Pages": String(pages),
      },
    });
  } catch (e) {
    console.error("[print/results/pdf]", e);
    // Generic message: navigation errors carry the ticketed URL.
    if (e instanceof PdfBusyError) return NextResponse.json({ error: "The PDF service is busy. Try again in a moment." }, { status: 503 });
    const msg =
      e instanceof PdfRenderError
        ? e.message === "layout" ? "The page layout failed. Try again." : "Some figures failed to load. Try again."
        : "The PDF could not be generated. Try again.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
