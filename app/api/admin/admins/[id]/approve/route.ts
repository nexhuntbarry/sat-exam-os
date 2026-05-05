import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/admins/[id]/approve
// Super-admin only. Sets the target admin's account_status to "approved"
// — used both for the initial approval after invite acceptance and for
// reactivating a previously-suspended admin.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const me = authResult;

  if (!me.isSuperAdmin) {
    return NextResponse.json(
      { error: "Only super admins can approve admins" },
      { status: 403 },
    );
  }

  const { id } = await params;
  const db = getServiceClient();

  const { data: target } = await db
    .from("users")
    .select("role")
    .eq("id", id)
    .maybeSingle();
  if (!target || target.role !== "admin") {
    return NextResponse.json({ error: "Admin not found" }, { status: 404 });
  }

  const { error } = await db
    .from("users")
    .update({ account_status: "approved", updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[admin/admins/approve]", error);
    return NextResponse.json({ error: "Failed to approve admin" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
