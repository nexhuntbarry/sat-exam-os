import { NextResponse } from "next/server";
import { getCurrentUser } from "./auth";
import type { UserRole } from "./clerk-helpers";

type RoleOrRoles = UserRole | UserRole[];

function toArray(r: RoleOrRoles): UserRole[] {
  return Array.isArray(r) ? r : [r];
}

/**
 * Middleware helper for Route Handlers.
 * Returns the CurrentUser if the authenticated user has the required role.
 * Returns a 401/403 NextResponse otherwise.
 *
 * Usage:
 *   const result = await requireRole("admin");
 *   if (result instanceof NextResponse) return result;
 *   const user = result;
 */
export async function requireRole(roles: RoleOrRoles) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const allowed = toArray(roles);
  if (!user.role || !allowed.includes(user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return user;
}

/**
 * Alias for requireRole — semantically clearer when multiple roles are fine.
 */
export const requireAnyRole = requireRole;

/**
 * Question-bank reviewer guard. Grants admins automatically; allows
 * teachers only when their `can_review_questions` flag is on. Use this
 * in question approve/reject/resolve-mismatch endpoints so a "key
 * teacher" can act without being promoted to admin.
 */
export async function requireQuestionReviewer() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!user.canReviewQuestions) {
    return NextResponse.json(
      { error: "You do not have question-review permission" },
      { status: 403 },
    );
  }
  return user;
}
