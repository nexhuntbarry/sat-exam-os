import { cache } from "react";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { getServiceClient } from "./supabase";
import type { UserRole } from "./clerk-helpers";
import { isQaEmail } from "./qa";

export interface CurrentUser {
  clerkId: string;
  email: string;
  role: UserRole | null;
  userId: string; // Supabase UUID
  displayName: string;
  accountStatus: string;
  /** Only meaningful when role === "admin". Gates the invite-admin flow. */
  isSuperAdmin: boolean;
  /** Implicit TRUE for admins; explicit toggle for "key teacher" reviewers. */
  canReviewQuestions: boolean;
  /** Hidden QA account (email starts with qa-test-); see lib/qa.ts. */
  isQa: boolean;
}

/**
 * Returns the current authenticated user: Clerk session (auth(), which
 * only verifies the session token locally) + the Supabase users row.
 * Deliberately does NOT call Clerk's currentUser() — that is a Backend
 * API request, rate-limited per instance, and a class autosaving at once
 * exhausted it (every save/submit 500'd). Everything we need lives in
 * the users table. Wrapped in React cache() so a layout + page + nested
 * server components share one lookup per request.
 * Uses service_role to bypass RLS.
 * Returns null if not authenticated or not found in Supabase.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  const supabase = getServiceClient();
  const { data: user, error } = await supabase
    .from("users")
    .select(
      "id, role, display_name, email, account_status, is_super_admin, can_review_questions",
    )
    .eq("clerk_user_id", clerkId)
    .maybeSingle();

  let row = user;
  if (!row && !error) row = await linkInvitedRowByEmail(clerkId);
  if (!row) return null;

  const role = row.role as UserRole | null;
  return {
    clerkId,
    email: row.email,
    role,
    userId: row.id,
    displayName: row.display_name,
    accountStatus: row.account_status,
    isSuperAdmin: Boolean(row.is_super_admin),
    // Admins implicitly review; teachers only when the explicit flag is on.
    canReviewQuestions: role === "admin" || Boolean(row.can_review_questions),
    isQa: isQaEmail(row.email),
  };
});

/**
 * Signed-in Clerk user with no linked users row. The Clerk webhook only links
 * an invited row on `user.created`, so an EXISTING Clerk account whose app row
 * was deleted and re-invited (e.g. a student re-invited as a teacher) never
 * gets linked: the user bounces between sign-in and the dashboard (2026-11-07,
 * Premier teacher). Link it here instead — only to an unlinked row whose email
 * matches one of the account's verified emails, with the webhook's rules.
 * Called only on a miss, so the Clerk Backend API call stays rare.
 */
async function linkInvitedRowByEmail(clerkId: string) {
  try {
    const client = await clerkClient();
    const cu = await client.users.getUser(clerkId);
    const emails = cu.emailAddresses
      .filter((e) => e.verification?.status === "verified")
      .map((e) => e.emailAddress.toLowerCase());
    if (emails.length === 0) return null;

    const supabase = getServiceClient();
    const { data: rows } = await supabase
      .from("users")
      .select("id, email, role, account_status")
      .is("clerk_user_id", null)
      .in("email", emails);
    if (!rows || rows.length !== 1) return null;
    const row = rows[0];

    const { data: linked, error } = await supabase
      .from("users")
      .update({
        clerk_user_id: clerkId,
        account_status: row.role === "teacher" ? "approved" : row.account_status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .is("clerk_user_id", null)
      .select(
        "id, role, display_name, email, account_status, is_super_admin, can_review_questions",
      )
      .maybeSingle();
    if (error || !linked) return null;
    console.warn("[auth] linked existing Clerk account to invited users row:", row.email);
    return linked;
  } catch (e) {
    console.error("[auth] linkInvitedRowByEmail failed:", e);
    return null;
  }
}
