import { auth, currentUser } from "@clerk/nextjs/server";
import { getServiceClient } from "./supabase";
import type { UserRole } from "./clerk-helpers";

export interface CurrentUser {
  clerkId: string;
  email: string;
  role: UserRole | null;
  userId: string; // Supabase UUID
  displayName: string;
  accountStatus: string;
}

/**
 * Returns the current authenticated user merging Clerk + Supabase data.
 * Uses service_role to bypass RLS.
 * Returns null if not authenticated or not found in Supabase.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const supabase = getServiceClient();
  const { data: user, error } = await supabase
    .from("users")
    .select("id, role, display_name, email, account_status")
    .eq("clerk_user_id", clerkId)
    .single();

  if (error || !user) return null;

  return {
    clerkId,
    email: user.email,
    role: user.role as UserRole | null,
    userId: user.id,
    displayName: user.display_name,
    accountStatus: user.account_status,
  };
}
