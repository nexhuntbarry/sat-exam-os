import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;

  let reason = "";
  try {
    const body = await req.json();
    reason = body.reason ?? "";
  } catch {
    // reason is optional
  }

  const db = getServiceClient();

  const { error } = await db
    .from("users")
    .update({ account_status: "suspended", updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[suspend] Failed to update user:", error);
    return NextResponse.json({ error: "Failed to suspend student" }, { status: 500 });
  }

  if (reason) {
    await db
      .from("student_profiles")
      .update({ status_reason: reason, updated_at: new Date().toISOString() })
      .eq("user_id", id);
  }

  return NextResponse.json({ ok: true });
}
