import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// DELETE /api/admin/admins/[id]
//
// Super-admin only. Permanently removes another admin user.
// Refuses to delete:
//   • A non-admin row (use the student/teacher delete endpoint instead)
//   • The caller themselves (must be deleted by another super admin)
//   • The last remaining super admin (orphaning the role)
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const me = authResult;

  if (!me.isSuperAdmin) {
    return NextResponse.json(
      { error: "Only super admins can remove admins" },
      { status: 403 },
    );
  }

  const { id } = await params;
  if (id === me.userId) {
    return NextResponse.json(
      { error: "You cannot delete yourself. Ask another super admin to remove you." },
      { status: 400 },
    );
  }

  const db = getServiceClient();

  const { data: target } = await db
    .from("users")
    .select("role, is_super_admin, display_name, email")
    .eq("id", id)
    .maybeSingle();
  if (!target) {
    return NextResponse.json({ error: "Admin not found" }, { status: 404 });
  }
  if (target.role !== "admin") {
    return NextResponse.json(
      { error: "User is not an admin — refusing to delete via this endpoint" },
      { status: 400 },
    );
  }

  // If target is a super admin, ensure at least one other super admin exists.
  if (target.is_super_admin) {
    const { count: otherSuperCount } = await db
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("is_super_admin", true)
      .neq("id", id);
    if ((otherSuperCount ?? 0) === 0) {
      return NextResponse.json(
        {
          error:
            "Cannot delete the last super admin. Promote another admin to super first.",
        },
        { status: 409 },
      );
    }
  }

  const { error } = await db.from("users").delete().eq("id", id);
  if (error) {
    console.error("[admin/admins/DELETE]", error);
    return NextResponse.json({ error: "Failed to delete admin" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    deleted: { id, display_name: target.display_name, email: target.email },
  });
}
