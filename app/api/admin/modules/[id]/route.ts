import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/admin/modules/[id]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data, error } = await db
    .from("modules")
    .select("*, questions(id, parsing_status)")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  return NextResponse.json({ data });
}

// DELETE /api/admin/modules/[id] — remove module + cascade questions + delete blob
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data: mod, error: fetchErr } = await db
    .from("modules")
    .select("id, pdf_url")
    .eq("id", id)
    .single();
  if (fetchErr || !mod) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  if (mod.pdf_url) {
    try {
      await del(mod.pdf_url);
    } catch (err) {
      console.warn("[modules DELETE] blob delete failed (continuing):", err);
    }
  }

  const { error } = await db.from("modules").delete().eq("id", id);
  if (error) {
    console.error("[modules DELETE] DB error:", error);
    return NextResponse.json({ error: "Failed to delete module" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
