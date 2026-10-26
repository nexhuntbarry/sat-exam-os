import { cache } from "react";
import { auth } from "@clerk/nextjs/server";
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
    .single();

  if (error || !user) return null;

  const role = user.role as UserRole | null;
  return {
    clerkId,
    email: user.email,
    role,
    userId: user.id,
    displayName: user.display_name,
    accountStatus: user.account_status,
    isSuperAdmin: Boolean(user.is_super_admin),
    // Admins implicitly review; teachers only when the explicit flag is on.
    canReviewQuestions: role === "admin" || Boolean(user.can_review_questions),
    isQa: isQaEmail(user.email),
  };
});
