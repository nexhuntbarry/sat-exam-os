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

// PATCH /api/admin/modules/[id] — edit metadata fields (name, section,
// module_number, difficulty, source, version). Does NOT touch the PDF
// or parsed questions; safe to call after parse.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;

  let body: {
    moduleName?: string;
    section?: "Math" | "Reading & Writing";
    moduleNumber?: 1 | 2 | null;
    difficulty?: "Easy" | "Medium" | "Hard" | "Mixed" | null;
    sourceName?: string | null;
    version?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.moduleName !== undefined) {
    const trimmed = body.moduleName.trim();
    if (!trimmed) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    updates.module_name = trimmed;
  }
  if (body.section !== undefined) {
    if (!["Math", "Reading & Writing"].includes(body.section)) {
      return NextResponse.json({ error: "Invalid section" }, { status: 400 });
    }
    updates.section = body.section;
  }
  if (body.moduleNumber !== undefined) {
    if (body.moduleNumber !== null && ![1, 2].includes(body.moduleNumber)) {
      return NextResponse.json({ error: "Module number must be 1 or 2" }, { status: 400 });
    }
    updates.module_number = body.moduleNumber;
  }
  if (body.difficulty !== undefined) {
    if (
      body.difficulty !== null &&
      !["Easy", "Medium", "Hard", "Mixed"].includes(body.difficulty)
    ) {
      return NextResponse.json({ error: "Invalid difficulty" }, { status: 400 });
    }
    updates.difficulty = body.difficulty;
  }
  if (body.sourceName !== undefined) updates.source_name = body.sourceName;
  if (body.version !== undefined) updates.version = body.version;

  const db = getServiceClient();
  const { error } = await db.from("modules").update(updates).eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
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
