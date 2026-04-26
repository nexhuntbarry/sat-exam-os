import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";

// GET /api/modules/[id]/page/[n]
// Returns a single-page PDF extracted from the module's source PDF.
// Used inside question-rendering iframes so students see ONLY the figure
// page, not the rest of the exam.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; n: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, n } = await params;
  const pageNum = parseInt(n, 10);
  if (!Number.isFinite(pageNum) || pageNum < 1) {
    return NextResponse.json({ error: "Bad page" }, { status: 400 });
  }

  const db = getServiceClient();
  const { data: mod } = await db
    .from("modules")
    .select("pdf_url, module_name")
    .eq("id", id)
    .single();
  if (!mod?.pdf_url) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  const headers: Record<string, string> = {};
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (blobToken && mod.pdf_url.includes(".blob.vercel-storage.com")) {
    headers.Authorization = `Bearer ${blobToken}`;
  }
  const upstream = await fetch(mod.pdf_url, { headers });
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
      "Cache-Control": "private, max-age=3600",
    },
  });
}
