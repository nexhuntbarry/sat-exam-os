import { auth, currentUser } from "@clerk/nextjs/server";

export type UserRole = "admin" | "teacher" | "student";

/**
 * Returns the role stored in Clerk publicMetadata, or null if unset.
 */
export async function getUserRole(): Promise<UserRole | null> {
  const user = await currentUser();
  if (!user) return null;
  const role = user.publicMetadata?.role as string | undefined;
  if (isValidRole(role)) return role;
  return null;
}

export function isValidRole(role: string | undefined): role is UserRole {
  return role === "admin" || role === "teacher" || role === "student";
}

export async function isAdmin(): Promise<boolean> {
  const role = await getUserRole();
  return role === "admin";
}

export async function isTeacher(): Promise<boolean> {
  const role = await getUserRole();
  return role === "teacher" || role === "admin";
}

export async function isStudent(): Promise<boolean> {
  const role = await getUserRole();
  return role === "student";
}

/**
 * Returns the Clerk userId or throws if not authenticated.
 */
export async function requireAuth(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthenticated");
  return userId;
}

/**
 * Returns the Clerk userId or null if not authenticated.
 */
export async function getAuthUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId;
}
