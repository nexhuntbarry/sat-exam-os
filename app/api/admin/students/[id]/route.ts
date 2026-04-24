import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// PATCH /api/admin/students/[id] — edit student
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const db = getServiceClient();
  const allowedProfileFields = ["grade", "school", "campus", "class_group", "target_score", "current_level", "notes"] as const;
  const profileUpdate: Record<string, unknown> = {};
  for (const f of allowedProfileFields) {
    if (f in body) profileUpdate[f] = body[f];
  }

  if (Object.keys(profileUpdate).length > 0) {
    const { error } = await db
      .from("student_profiles")
      .update({ ...profileUpdate, updated_at: new Date().toISOString() })
      .eq("user_id", id);
    if (error) {
      return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
