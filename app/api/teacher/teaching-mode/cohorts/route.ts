import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getQaClassGroupIds, scopeIds } from "@/lib/qa";

// GET /api/teacher/teaching-mode/cohorts
// Returns the class groups available to this teacher for the quick-
// create cohort picker: only the classes the teacher actually teaches
// (class_group_teachers). Classes merely referenced by some test they're on
// teacher_ids for are NOT theirs — listing them let a teacher assign tests
// to (and then read results of) other classes. Admin sees every class group.
export async function GET() {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const db = getServiceClient();
  const qaGroups = await getQaClassGroupIds();

  if (user.role === "admin") {
    const { data } = await scopeIds(db
      .from("class_groups")
      .select("id, name, campus, grade"), "id", qaGroups, user.isQa);
    return NextResponse.json({ cohorts: data ?? [] });
  }

  const { data: owned, error } = await db
    .from("class_group_teachers")
    .select("class_group_id")
    .eq("teacher_id", user.userId);
  if (error) {
    console.error("[teaching-mode/cohorts]", error);
    return NextResponse.json({ error: "Failed to load classes" }, { status: 500 });
  }
  const cohortIds = new Set((owned ?? []).map((g) => g.class_group_id as string));

  if (cohortIds.size === 0) return NextResponse.json({ cohorts: [] });

  const { data: cohorts } = await scopeIds(db
    .from("class_groups")
    .select("id, name, campus, grade")
    .in("id", Array.from(cohortIds)), "id", qaGroups, user.isQa);

  return NextResponse.json({ cohorts: cohorts ?? [] });
}
