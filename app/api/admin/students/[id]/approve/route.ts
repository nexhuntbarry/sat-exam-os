import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { sendEmail } from "@/lib/email/send";
import { approvalEmail } from "@/lib/email/templates/approval";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;

  let body: {
    campus?: string;
    classGroupId?: string;
    grade?: string;
    targetScore?: number;
    notes?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    // body is optional
  }

  const db = getServiceClient();

  // Fetch user info for email. SECURITY: scope to role='student' so
  // this student-only endpoint can't be used to approve a teacher or
  // admin by passing their user_id.
  const { data: userRow, error: userErr } = await db
    .from("users")
    .select("id, email, display_name, account_status")
    .eq("id", id)
    .eq("role", "student")
    .single();

  if (userErr || !userRow) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  // Update user account_status → approved
  const { error: updateErr } = await db
    .from("users")
    .update({ account_status: "approved", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("role", "student");

  if (updateErr) {
    console.error("[approve] Failed to update user status:", updateErr);
    return NextResponse.json({ error: "Failed to approve student" }, { status: 500 });
  }

  // Update student_profiles if fields supplied
  const profilePatch: Record<string, unknown> = {};
  if (body.campus) profilePatch.campus = body.campus;
  if (body.grade) profilePatch.grade = body.grade;
  if (body.targetScore) profilePatch.target_score = body.targetScore;
  if (body.notes) profilePatch.notes = body.notes;
  if (body.classGroupId) profilePatch.class_group = body.classGroupId;

  if (Object.keys(profilePatch).length > 0) {
    await db
      .from("student_profiles")
      .update({ ...profilePatch, updated_at: new Date().toISOString() })
      .eq("user_id", id);
  }

  // Add to class group members if classGroupId provided
  if (body.classGroupId) {
    await db.from("class_group_members").upsert(
      { class_group_id: body.classGroupId, student_id: id },
      { onConflict: "class_group_id,student_id" }
    );
  }

  // Send approval email (non-blocking)
  const { subject, html } = approvalEmail(userRow.display_name ?? userRow.email);
  sendEmail({ to: userRow.email, subject, html }).catch(() => {});

  // Notify parent if available
  const { data: profile } = await db
    .from("student_profiles")
    .select("parent_email, parent_name")
    .eq("user_id", id)
    .single();

  if (profile?.parent_email) {
    sendEmail({
      to: profile.parent_email,
      subject: "Your child's SAT Exam OS account is approved!",
      html: approvalEmail(`${userRow.display_name ?? userRow.email}'s parent`).html,
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
