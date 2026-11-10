import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";

// DELETE /api/admin/students/[id]/check-profile — clear the check_profile flag
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { userIds: [id] });
  if (crossSide) return crossSide;

  const db = getServiceClient();

  const { data: user } = await db
    .from("users")
    .select("metadata")
    .eq("id", id)
    .eq("role", "student")
    .maybeSingle();

  if (!user) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  const meta = (user.metadata ?? {}) as Record<string, unknown>;
  const { check_profile: _removed, ...rest } = meta;

  const { error } = await db
    .from("users")
    .update({ metadata: rest, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("role", "student");

  if (error) {
    console.error("[check-profile/DELETE] Failed to update user:", error);
    return NextResponse.json({ error: "Failed to clear flag" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
