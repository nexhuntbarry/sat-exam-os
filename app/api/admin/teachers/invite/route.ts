import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { isQaEmail } from "@/lib/qa";
import { isValidEmail, normalizeEmail } from "../../_shared";
import { sendEmail } from "@/lib/email/send";
import { teacherInviteEmail } from "@/lib/email/templates/teacher-invite";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://sat.nexhunt.xyz";

export async function POST(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const admin = authResult;

  let body: {
    email: string;
    displayName?: string;
    resend?: boolean;
    canReviewQuestions?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Emails are compared case-insensitively everywhere; store lowercase so
  // "Ann@x.com" and "ann@x.com" can't become two teacher rows.
  const email = normalizeEmail(body.email);
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }
  if (isQaEmail(email) !== authResult.isQa) {
    return NextResponse.json(
      { error: "Cannot link QA and real accounts/data" },
      { status: 403 },
    );
  }

  const canReview = Boolean(body.canReviewQuestions);
  const db = getServiceClient();

  // Pre-check for existing user by email — return 409 with a flag so the
  // admin UI can prompt "user exists, resend invite?" instead of a hard fail.
  const { data: matches, error: lookupErr } = await db
    .from("users")
    .select("id, email, display_name, role, account_status")
    .ilike("email", email.replace(/[\\%_]/g, "\\$&"))
    .limit(2);
  if (lookupErr) {
    console.error("[invite-teacher] lookup error:", lookupErr);
    return NextResponse.json({ error: "Failed to check existing users" }, { status: 500 });
  }
  const existing = (matches ?? []).find((u) => u.role === "teacher") ?? matches?.[0] ?? null;

  // A student/admin with this email must not be turned into (or flagged
  // like) a teacher by the resend path.
  if (existing && existing.role !== "teacher") {
    return NextResponse.json(
      { error: `This email already belongs to a ${existing.role} account, so it can't be invited as a teacher.` },
      { status: 409 },
    );
  }

  if (existing && !body.resend) {
    return NextResponse.json(
      {
        error: "exists",
        existingUser: existing,
        message: "A user with that email already exists. Confirm to resend the invite email.",
      },
      { status: 409 },
    );
  }

  let userId: string;
  if (existing) {
    // Resend path — keep the row but update the reviewer flag if the
    // admin chose differently this time.
    userId = existing.id;
    await db
      .from("users")
      .update({ can_review_questions: canReview, updated_at: new Date().toISOString() })
      .eq("id", userId);
  } else {
    const { data: newUser, error: insertErr } = await db
      .from("users")
      .insert({
        email,
        display_name: body.displayName?.trim() || email.split("@")[0],
        role: "teacher",
        account_status: "pending",
        can_review_questions: canReview,
        metadata: { invited: true },
      })
      .select("id")
      .single();
    if (insertErr || !newUser) {
      console.error("[invite-teacher] DB error:", insertErr);
      return NextResponse.json({ error: "Failed to create teacher record" }, { status: 500 });
    }
    userId = newUser.id;
    await db.from("teacher_profiles").insert({
      user_id: userId,
      invited_by: admin.userId,
    });
  }

  // Build invite URL — Clerk sign-in with email pre-filled (best effort)
  const inviteUrl = `${BASE_URL}/sign-in?email=${encodeURIComponent(email)}`;

  // Send invite email — DB row is already created, so any failure here
  // becomes a non-fatal warning (admin can re-invite or share the link
  // manually). We still want to surface it so the UI doesn't lie about
  // success.
  const { subject, html } = teacherInviteEmail(inviteUrl, admin.displayName);
  let emailWarning: string | null = null;
  try {
    await sendEmail({ to: email, subject, html });
  } catch (err) {
    emailWarning = err instanceof Error ? err.message : String(err);
    console.error("[invite-teacher] email failed:", err);
  }

  return NextResponse.json({
    ok: true,
    userId,
    resent: !!existing,
    ...(emailWarning ? { emailWarning } : {}),
  });
}
