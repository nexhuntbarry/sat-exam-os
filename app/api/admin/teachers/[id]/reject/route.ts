import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";

// POST /api/admin/teachers/[id]/reject — reject a PENDING teacher sign-up
// (account_status → suspended, like rejecting a student). Only pending
// rows: approved teachers are removed via Remove. The row and email stay;
// use Change role or Remove to free the email.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { userIds: [id] });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  const { data, error } = await db
    .from("users")
    .update({ account_status: "suspended", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("role", "teacher")
    .eq("account_status", "pending")
    .not("clerk_user_id", "is", null)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[reject-teacher] DB error:", error);
    return NextResponse.json({ error: "Failed to reject teacher" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "No pending teacher sign-up to reject" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
