import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/teacher/teaching-mode/cohorts
// Returns the class groups this teacher's currently-assigned tests touch,
// so the quick-create modal can show a cohort picker without exposing every
// class group platform-wide.
export async function GET() {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const db = getServiceClient();

  const { data: assignments } = await db
    .from("test_assignments")
    .select("class_group_ids")
    .contains("teacher_ids", JSON.stringify([user.userId]));

  const cohortIds = Array.from(
    new Set(
      (assignments ?? []).flatMap((a) => (a.class_group_ids as string[]) ?? [])
    )
  );

  if (cohortIds.length === 0) return NextResponse.json({ cohorts: [] });

  const { data: cohorts } = await db
    .from("class_groups")
    .select("id, name, campus, grade")
    .in("id", cohortIds);

  return NextResponse.json({ cohorts: cohorts ?? [] });
}
