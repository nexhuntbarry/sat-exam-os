import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/tests/[id]/publish
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
    .update({ status: "Published", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "Draft");

  if (error) {
    console.error("[admin/tests/publish]", error);
    return NextResponse.json({ error: "Failed to publish test" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
