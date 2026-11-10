import type { getServiceClient } from "@/lib/supabase";

type DbClient = ReturnType<typeof getServiceClient>;
export type SwitchableRole = "student" | "teacher" | "admin";

/**
 * Side tables that must follow a users.role change. Shared by the
 * self-service switch (/api/account/role, pending accounts only) and the
 * admin "Change role" endpoint. Submissions, student_profiles and
 * teacher_profiles are kept (history); only class links that no longer
 * make sense for the new role are dropped:
 *   → teacher: drop class_group_members, ensure a teacher_profiles row
 *   → student: drop class_group_teachers, ensure a student_profiles row
 *   → admin:   drop both
 * Returns an error message, or null on success.
 */
export async function syncRoleSideTables(
  db: DbClient,
  userId: string,
  to: SwitchableRole,
): Promise<string | null> {
  if (to === "teacher" || to === "admin") {
    const { error } = await db.from("class_group_members").delete().eq("student_id", userId);
    if (error) return `Failed to remove class memberships: ${error.message}`;
  }
  if (to === "student" || to === "admin") {
    const { error } = await db.from("class_group_teachers").delete().eq("teacher_id", userId);
    if (error) return `Failed to remove class assignments: ${error.message}`;
  }
  if (to === "teacher") {
    const { error } = await db
      .from("teacher_profiles")
      .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
    if (error) return `Failed to create teacher profile: ${error.message}`;
  }
  if (to === "student") {
    const { error } = await db
      .from("student_profiles")
      .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
    if (error) return `Failed to create student profile: ${error.message}`;
  }
  return null;
}
