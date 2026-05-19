import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/teacher/teaching-mode/cohorts
// Returns the class groups available to this teacher for the quick-
// create cohort picker. Sources, unioned:
//   1) class_groups the teacher owns directly via class_group_teachers
//      (primary signal — these are "my classes")
//   2) class_group_ids referenced by any test where the teacher is
//      directly on test_assignments.teacher_ids (legacy reviewer mode)
// Admin sees every class group.
export async function GET() {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const db = getServiceClient();

  if (user.role === "admin") {
    const { data } = await db
      .from("class_groups")
      .select("id, name, campus, grade");
    return NextResponse.json({ cohorts: data ?? [] });
  }

  const cohortIds = new Set<string>();

  const { data: owned } = await db
    .from("class_group_teachers")
    .select("class_group_id")
    .eq("teacher_id", user.userId);
  for (const g of owned ?? []) cohortIds.add(g.class_group_id as string);

  const { data: assignments } = await db
    .from("test_assignments")
    .select("class_group_ids")
    .contains("teacher_ids", JSON.stringify([user.userId]));
  for (const a of assignments ?? []) {
    for (const id of (a.class_group_ids as string[] | null) ?? []) {
      cohortIds.add(id);
    }
  }

  if (cohortIds.size === 0) return NextResponse.json({ cohorts: [] });

  const { data: cohorts } = await db
    .from("class_groups")
    .select("id, name, campus, grade")
    .in("id", Array.from(cohortIds));

  return NextResponse.json({ cohorts: cohorts ?? [] });
}
