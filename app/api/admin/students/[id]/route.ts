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

  // user-table fields (display_name, email) edited via this endpoint
  // because typos happen and admins shouldn't have to hand-edit Clerk +
  // Supabase separately for a name fix.
  const allowedUserFields = ["display_name", "email"] as const;
  const userUpdate: Record<string, unknown> = {};
  for (const f of allowedUserFields) {
    if (f in body) {
      const v = body[f];
      if (typeof v === "string") userUpdate[f] = v.trim();
    }
  }

  if (Object.keys(userUpdate).length > 0) {
    const { error } = await db
      .from("users")
      .update({ ...userUpdate, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("role", "student");
    if (error) {
      console.error("[admin/students/PATCH user]", error);
      return NextResponse.json({ error: "Failed to update student" }, { status: 500 });
    }
  }

  // student_profiles fields
  const allowedProfileFields = [
    "grade",
    "school",
    "campus",
    "class_group",
    "target_score",
    "current_level",
    "parent_name",
    "parent_email",
    "parent_phone",
    "notes",
  ] as const;
  const profileUpdate: Record<string, unknown> = {};
  for (const f of allowedProfileFields) {
    if (f in body) {
      const v = body[f];
      // Numeric coercion for target_score; everything else passes through.
      if (f === "target_score") {
        if (v === null || v === "") profileUpdate[f] = null;
        else if (typeof v === "number") profileUpdate[f] = v;
        else if (typeof v === "string") {
          const n = parseInt(v, 10);
          profileUpdate[f] = Number.isFinite(n) ? n : null;
        }
      } else if (typeof v === "string") {
        profileUpdate[f] = v.trim() || null;
      } else if (v === null) {
        profileUpdate[f] = null;
      }
    }
  }

  if (Object.keys(profileUpdate).length > 0) {
    const { error } = await db
      .from("student_profiles")
      .update({ ...profileUpdate, updated_at: new Date().toISOString() })
      .eq("user_id", id);
    if (error) {
      console.error("[admin/students/PATCH profile]", error);
      return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
