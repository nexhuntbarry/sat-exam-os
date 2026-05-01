import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { sendEmail } from "@/lib/email/send";
import { adminInviteEmail } from "@/lib/email/templates/admin-invite";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://sat.nexhunt.xyz";

// POST /api/admin/admins/invite
//
// Mirrors the teacher-invite flow but creates a `role: "admin"` user and
// is gated behind is_super_admin. Only super admins can grant the admin
// role to a new user, preventing accidental privilege escalation.
export async function POST(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const inviter = authResult;

  if (!inviter.isSuperAdmin) {
    return NextResponse.json(
      { error: "Only super admins can invite new admins" },
      { status: 403 },
    );
  }

  let body: { email: string; displayName?: string; resend?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const db = getServiceClient();

  const { data: existing } = await db
    .from("users")
    .select("id, email, display_name, role, account_status, is_super_admin")
    .eq("email", body.email)
    .maybeSingle();

  if (existing && !body.resend) {
    return NextResponse.json(
      {
        error: "exists",
        existingUser: existing,
        message:
          "A user with that email already exists. Confirm to resend the invite email.",
      },
      { status: 409 },
    );
  }

  let userId: string;
  if (existing) {
    userId = existing.id;
    // If the existing record is non-admin, promote to admin on resend so the
    // invite is meaningful when accepted. is_super_admin is left FALSE.
    if (existing.role !== "admin") {
      await db
        .from("users")
        .update({ role: "admin", account_status: "pending", updated_at: new Date().toISOString() })
        .eq("id", userId);
    }
  } else {
    const { data: newUser, error: insertErr } = await db
      .from("users")
      .insert({
        email: body.email,
        display_name: body.displayName ?? body.email.split("@")[0],
        role: "admin",
        account_status: "pending",
        is_super_admin: false,
        metadata: { invited: true, invited_by: inviter.userId },
      })
      .select("id")
      .single();
    if (insertErr || !newUser) {
      console.error("[invite-admin] DB error:", insertErr);
      return NextResponse.json(
        { error: "Failed to create admin record" },
        { status: 500 },
      );
    }
    userId = newUser.id;
  }

  const inviteUrl = `${BASE_URL}/sign-in?email=${encodeURIComponent(body.email)}`;
  const { subject, html } = adminInviteEmail(inviteUrl, inviter.displayName);
  let emailWarning: string | null = null;
  try {
    await sendEmail({ to: body.email, subject, html });
  } catch (err) {
    emailWarning = err instanceof Error ? err.message : String(err);
    console.error("[invite-admin] email failed:", err);
  }

  return NextResponse.json({
    ok: true,
    userId,
    resent: !!existing,
    ...(emailWarning ? { emailWarning } : {}),
  });
}
