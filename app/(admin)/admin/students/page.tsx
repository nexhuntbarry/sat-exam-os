import { clerkClient } from "@clerk/nextjs/server";
import { getServiceClient } from "@/lib/supabase";
import StudentsClient from "./StudentsClient";
import PageIntro from "@/components/shared/PageIntro";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, scopeIds, scopeUsers } from "@/lib/qa";
import { fetchAllRows } from "@/lib/fetch-all-rows";

async function getStudents(viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data } = await scopeUsers(db
    .from("users")
    .select(
      `id, email, display_name, account_status, created_at, clerk_user_id,
       student_profiles(grade, school, campus, class_group, parent_name, parent_email, parent_phone, target_score, current_level, status_reason)`
    )
    .eq("role", "student"), viewerIsQa)
    .order("created_at", { ascending: false });
  const students = data ?? [];

  const clerkIds = students
    .map((s) => s.clerk_user_id as string | null)
    .filter((id): id is string => Boolean(id));

  let lastSignInById: Record<string, number | null> = {};
  if (clerkIds.length > 0) {
    try {
      const cc = await clerkClient();
      const resp = await cc.users.getUserList({ userId: clerkIds, limit: clerkIds.length });
      lastSignInById = Object.fromEntries(
        resp.data.map((u) => [u.id, u.lastSignInAt ?? null]),
      );
    } catch (err) {
      console.error("[students] Clerk getUserList failed:", err);
    }
  }

  return students.map((s) => ({
    ...s,
    last_sign_in_at: s.clerk_user_id ? lastSignInById[s.clerk_user_id as string] ?? null : null,
  }));
}

async function getClassGroups(viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data } = await scopeIds(db
    .from("class_groups")
    .select("id, name, campus, grade"), "id", await getQaClassGroupIds(), viewerIsQa)
    .order("name");
  return data ?? [];
}

export default async function StudentsPage() {
  const isQa = (await getCurrentUser())?.isQa ?? false;
  const [students, classGroups] = await Promise.all([
    getStudents(isQa),
    getClassGroups(isQa),
  ]);

  // Class memberships per student (only groups visible to this viewer side).
  const nameById = new Map(classGroups.map((g) => [g.id as string, g.name as string]));
  const membershipsByStudent: Record<string, { id: string; name: string }[]> = {};
  if (students.length > 0 && nameById.size > 0) {
    const memberDb = getServiceClient();
    const cgKeys = [...nameById.keys()];
    const { data: members } = await fetchAllRows<{ student_id: string; class_group_id: string }>((from, to) =>
      memberDb
        .from("class_group_members")
        .select("student_id, class_group_id")
        .in("class_group_id", cgKeys)
        .order("student_id")
        .order("class_group_id")
        .range(from, to),
    );
    for (const m of members ?? []) {
      const name = nameById.get(m.class_group_id as string);
      if (!name) continue;
      (membershipsByStudent[m.student_id as string] ??= []).push({
        id: m.class_group_id as string,
        name,
      });
    }
  }
  const withClasses = students.map((s) => ({
    ...s,
    classes: (membershipsByStudent[s.id as string] ?? []).map((m) => m.name).sort(),
    classMemberships: (membershipsByStudent[s.id as string] ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  }));

  return (
    <>
      <PageIntro tKey="admin.students" />
      <StudentsClient students={withClasses} classGroups={classGroups} />
    </>
  );
}
