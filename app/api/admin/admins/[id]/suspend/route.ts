import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/admins/[id]/suspend
// Super-admin only. Sets the target admin's account_status to "suspended"
// so they can't sign in until re-approved. Refuses to suspend the caller
// or the last active super admin.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const me = authResult;

  if (!me.isSuperAdmin) {
    return NextResponse.json(
      { error: "Only super admins can suspend admins" },
      { status: 403 },
    );
  }

  const { id } = await params;
  if (id === me.userId) {
    return NextResponse.json(
      { error: "You cannot suspend yourself" },
      { status: 400 },
    );
  }

  const db = getServiceClient();
  const { data: target } = await db
    .from("users")
    .select("role, is_super_admin")
    .eq("id", id)
    .maybeSingle();
  if (!target || target.role !== "admin") {
    return NextResponse.json({ error: "Admin not found" }, { status: 404 });
  }

  if (target.is_super_admin) {
    const { count: otherActiveSuper } = await db
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin")
      .eq("is_super_admin", true)
      .eq("account_status", "approved")
      .neq("id", id);
    if ((otherActiveSuper ?? 0) === 0) {
      return NextResponse.json(
        {
          error:
            "Cannot suspend the last active super admin. Promote another admin first.",
        },
        { status: 409 },
      );
    }
  }

  const { error } = await db
    .from("users")
    .update({ account_status: "suspended", updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[admin/admins/suspend]", error);
    return NextResponse.json({ error: "Failed to suspend admin" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
