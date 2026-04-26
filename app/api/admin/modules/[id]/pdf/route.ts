import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/admin/modules/[id]/pdf
// Streams the module PDF from a private Vercel Blob store, adding the
// Authorization header that the browser cannot. Admin-only.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const db = getServiceClient();
  const { data: mod, error } = await db
    .from("modules")
    .select("pdf_url, module_name")
    .eq("id", id)
    .single();
  if (error || !mod?.pdf_url) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const headers: Record<string, string> = {};
  if (blobToken && mod.pdf_url.includes(".blob.vercel-storage.com")) {
    headers.Authorization = `Bearer ${blobToken}`;
  }
  const upstream = await fetch(mod.pdf_url, { headers });
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Upstream ${upstream.status}` },
      { status: upstream.status === 404 ? 404 : 502 },
    );
  }

  const safeName = (mod.module_name ?? "module").replace(/[^a-z0-9._-]+/gi, "_");
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safeName}.pdf"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}
