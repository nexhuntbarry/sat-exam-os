import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { sendEmail } from "@/lib/email/send";
import { teacherInviteEmail } from "@/lib/email/templates/teacher-invite";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://sat.nexhunt.xyz";

export async function POST(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const admin = authResult;

  let body: { email: string; displayName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const db = getServiceClient();

  // Create user row with role=teacher, account_status=pending
  const { data: newUser, error: insertErr } = await db
    .from("users")
    .insert({
      email: body.email,
      display_name: body.displayName ?? body.email.split("@")[0],
      role: "teacher",
      account_status: "pending",
      metadata: { invited: true },
    })
    .select("id")
    .single();

  if (insertErr) {
    // If duplicate email, return graceful message
    if (insertErr.code === "23505") {
      return NextResponse.json({ error: "A user with that email already exists" }, { status: 409 });
    }
    console.error("[invite-teacher] DB error:", insertErr);
    return NextResponse.json({ error: "Failed to create teacher record" }, { status: 500 });
  }

  // Create teacher_profiles row
  await db.from("teacher_profiles").insert({
    user_id: newUser.id,
    invited_by: admin.userId,
  });

  // Build invite URL — Clerk sign-in with email pre-filled (best effort)
  const inviteUrl = `${BASE_URL}/sign-in?email=${encodeURIComponent(body.email)}`;

  // Send invite email (non-blocking)
  const { subject, html } = teacherInviteEmail(inviteUrl, admin.displayName);
  sendEmail({ to: body.email, subject, html }).catch(() => {});

  return NextResponse.json({ ok: true, userId: newUser.id });
}
