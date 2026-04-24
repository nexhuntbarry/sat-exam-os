import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// PATCH /api/admin/class-groups/[id]
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  let body: { name?: string; campus?: string; grade?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, string> = {};
  if (body.name) patch.name = body.name;
  if (body.campus !== undefined) patch.campus = body.campus;
  if (body.grade !== undefined) patch.grade = body.grade;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const db = getServiceClient();
  const { error } = await db.from("class_groups").update(patch).eq("id", id);

  if (error) {
    console.error("[class-groups/patch] DB error:", error);
    return NextResponse.json({ error: "Failed to update class group" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
