import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/teachers/[id]/remove — set status=suspended
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const url = new URL(req.url);

  if (!url.pathname.endsWith("/remove")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = getServiceClient();
  const { error } = await db
    .from("users")
    .update({ account_status: "suspended", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("role", "teacher");

  if (error) {
    console.error("[remove-teacher] DB error:", error);
    return NextResponse.json({ error: "Failed to remove teacher" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// PATCH /api/admin/teachers/[id] — edit teacher (e.g., assigned_classes)
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  let body: { assignedClasses?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const db = getServiceClient();

  if (body.assignedClasses !== undefined) {
    const { error } = await db
      .from("teacher_profiles")
      .update({ assigned_classes: body.assignedClasses })
      .eq("user_id", id);
    if (error) {
      return NextResponse.json({ error: "Failed to update teacher profile" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
