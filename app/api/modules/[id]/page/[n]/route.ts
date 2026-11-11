import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { parseBlobUrl } from "@/lib/blob-url";
import { canViewModulePage, UUID_RE } from "@/lib/module-page-access";

// GET /api/modules/[id]/page/[n]
// Returns a single-page PDF extracted from the module's source PDF.
// Used inside question-rendering iframes so students see ONLY the figure
// page, not the rest of the exam.
//
// Access (lib/module-page-access.ts): question reviewers any page; approved
// teachers pages of tests they can open; approved students pages of modules
// they were served (in progress, or finished with answers visible to them).
// Optional ?test=<id> tells a teacher check which test to verify.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; n: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, n } = await params;
  const pageNum = parseInt(n, 10);
  if (!Number.isFinite(pageNum) || pageNum < 1) {
    return NextResponse.json({ error: "Bad page" }, { status: 400 });
  }
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  const db = getServiceClient();
  const testHint = new URL(req.url).searchParams.get("test");
  let allowed: boolean;
  try {
    allowed = await canViewModulePage(db, user, id, pageNum, testHint);
  } catch (e) {
    console.error("[modules/page] access check failed", e);
    return NextResponse.json({ error: "Access check failed" }, { status: 500 });
  }
  if (!allowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { data: mod } = await db
    .from("modules")
    .select("pdf_url, module_name")
    .eq("id", id)
    .single();
  if (!mod?.pdf_url) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  // Only fetch (and only send the Blob token to) a real Vercel Blob URL.
  const pdfUrl = parseBlobUrl(mod.pdf_url);
  if (!pdfUrl) {
    return NextResponse.json({ error: "Module PDF is not a Vercel Blob URL" }, { status: 502 });
  }
  const headers: Record<string, string> = {};
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (blobToken) {
    headers.Authorization = `Bearer ${blobToken}`;
  }
  const upstream = await fetch(pdfUrl.href, { headers, redirect: "error" });
  if (!upstream.ok) {
    return NextResponse.json({ error: `Upstream ${upstream.status}` }, { status: 502 });
  }
  const fullBuffer = Buffer.from(await upstream.arrayBuffer());

  const src = await PDFDocument.load(fullBuffer);
  if (pageNum > src.getPageCount()) {
    return NextResponse.json({ error: "Page out of range" }, { status: 404 });
  }
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [pageNum - 1]);
  out.addPage(copied);
  const bytes = await out.save();
  // pdf-lib returns Uint8Array — copy into a Node Buffer for stable Body typing
  const body = Buffer.from(bytes);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="page-${pageNum}.pdf"`,
      // Per-user decision: never cache in a shared cache.
      "Cache-Control": "private, max-age=600",
      Vary: "Cookie",
    },
  });
}
