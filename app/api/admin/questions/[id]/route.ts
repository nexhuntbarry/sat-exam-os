import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/admin/questions/[id]
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { data, error } = await db
    .from("questions")
    .select(`*, modules(module_name, source_name, pdf_url, section, difficulty, module_number)`)
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  return NextResponse.json({ data });
}

// PATCH /api/admin/questions/[id]
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const body = await req.json();

  // Whitelist updatable fields
  const allowed = [
    "question_text",
    "choices",
    "correct_answer",
    "explanation",
    "difficulty",
    "domain",
    "skill",
    "concept",
    "question_type",
    "has_image",
    "has_table",
    "has_formula",
    "parsing_status",
    "parsing_notes",
    "page_number",
    "official_answer",
    "mismatch_with_official",
  ] as const;

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (key in body) update[key] = body[key];
  }

  const db = getServiceClient();
  const { data, error } = await db
    .from("questions")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    console.error("[questions/PATCH] error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ data });
}
