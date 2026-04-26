import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  // Hard delete teacher row + cascade teacher_profiles + delete Clerk user
  // so the email is fully reusable. Verify it's a teacher first to prevent
  // accidental admin/student deletion.
  const { data: target } = await db
    .from("users")
    .select("id, role, clerk_user_id, email")
    .eq("id", id)
    .single();
  if (!target || target.role !== "teacher") {
    return NextResponse.json({ error: "Not a teacher" }, { status: 404 });
  }

  await db.from("teacher_profiles").delete().eq("user_id", id);
  const { error } = await db.from("users").delete().eq("id", id).eq("role", "teacher");
  if (error) {
    console.error("[remove-teacher] DB error:", error);
    return NextResponse.json({ error: "Failed to remove teacher" }, { status: 500 });
  }

  // Best-effort: delete Clerk user so re-using the email creates a fresh
  // sign-in. Don't fail the request if Clerk delete errors (the Supabase
  // row is already gone, which is the source of truth for app state).
  if (target.clerk_user_id) {
    try {
      const cc = await clerkClient();
      await cc.users.deleteUser(target.clerk_user_id);
    } catch (err) {
      console.warn(
        `[remove-teacher] Clerk delete failed for ${target.email}:`,
        err,
      );
    }
  }

  return NextResponse.json({ ok: true });
}
