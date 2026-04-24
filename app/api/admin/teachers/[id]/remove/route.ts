import { NextResponse } from "next/server";
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

  const { error } = await db
    .from("users")
    .update({ account_status: "suspended", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("role", "teacher");

  if (error) {
    console.error("[remove-teacher] DB error:", error);
    return NextResponse.json({ error: "Failed to remove teacher" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
