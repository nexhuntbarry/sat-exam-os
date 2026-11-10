import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide, isQaEmail } from "@/lib/qa";
import { sendEmail } from "@/lib/email/send";
import { approvalEmail } from "@/lib/email/templates/approval";

// POST /api/admin/teachers/[id]/approve — approve a self-signed-up
// (pending) teacher, or reactivate a suspended one. Teacher-only, like
// /api/admin/students/[id]/approve is student-only.
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
  const { data: userRow } = await db
    .from("users")
    .select("id, email, display_name, account_status")
    .eq("id", id)
    .eq("role", "teacher")
    .maybeSingle();
  if (!userRow) {
    return NextResponse.json({ error: "Teacher not found" }, { status: 404 });
  }

  const { error } = await db
    .from("users")
    .update({ account_status: "approved", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("role", "teacher");
  if (error) {
    console.error("[approve-teacher] DB error:", error);
    return NextResponse.json({ error: "Failed to approve teacher" }, { status: 500 });
  }

  await db
    .from("teacher_profiles")
    .upsert({ user_id: id }, { onConflict: "user_id", ignoreDuplicates: true });

  // Only a first approval gets the email (not a reactivation); QA
  // accounts never get mail.
  if (userRow.account_status === "pending" && !isQaEmail(userRow.email)) {
    const { subject, html } = approvalEmail(userRow.display_name ?? userRow.email, "teacher");
    sendEmail({ to: userRow.email, subject, html }).catch(() => {});
  }

  return NextResponse.json({ ok: true, reactivated: userRow.account_status === "suspended" });
}
