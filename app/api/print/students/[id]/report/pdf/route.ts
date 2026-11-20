import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { PrintAccessError } from "@/lib/result-printout";
import { mintReportTicket } from "@/lib/print-token";
import { watermarkOn } from "@/lib/print-watermark";
import { loadOnePageReport } from "@/lib/one-page-report-data";
import { PdfBusyError, PdfRenderError, renderPrintPdf } from "@/lib/render-pdf";

export const runtime = "nodejs";
export const maxDuration = 60;

// GET /api/print/students/<studentId>/report/pdf?lang=en|zh&wm=0
// The one-page parent report as a PDF file: the /print/students/<id>/report
// page rendered by headless Chromium (same pipeline as the result printouts).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role === "teacher" && user.accountStatus !== "approved") return NextResponse.json({ error: "Account not active" }, { status: 403 });
  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  const l = sp.get("lang");
  const lang = l === "en" || l === "zh" ? l : (await getLocale()) === "en" ? "en" : "zh";
  const viewer = { userId: user.userId, role: user.role, isQa: user.isQa };
  // Premier watermark: wm=0 is honoured for admins only; teachers always get it.
  const wm = watermarkOn(user.role, sp.get("wm"));

  // Access check up front (the print page checks again with the ticket).
  let name: string;
  try {
    const data = await loadOnePageReport(getServiceClient(), viewer, id);
    name = `${data.studentName} – SAT Score Report.pdf`;
  } catch (e) {
    if (e instanceof PrintAccessError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  try {
    const ticket = mintReportTicket({ viewer, studentId: id, lang, wm });
    const url = `${new URL(req.url).origin}/print/students/${id}/report?pt=${encodeURIComponent(ticket)}`;
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
    console.error("[print/students/report/pdf]", e);
    // Generic message: navigation errors carry the ticketed URL.
    if (e instanceof PdfBusyError) return NextResponse.json({ error: "The PDF service is busy. Try again in a moment." }, { status: 503 });
    const msg = e instanceof PdfRenderError && e.message === "layout" ? "The page layout failed. Try again." : "The PDF could not be generated. Try again.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
