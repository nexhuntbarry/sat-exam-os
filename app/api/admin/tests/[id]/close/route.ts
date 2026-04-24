import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/tests/[id]/close
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { error } = await db
    .from("tests")
    .update({ status: "Closed", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "Published");

  if (error) {
    console.error("[admin/tests/close]", error);
    return NextResponse.json({ error: "Failed to close test" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
