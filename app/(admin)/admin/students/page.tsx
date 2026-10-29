import { clerkClient } from "@clerk/nextjs/server";
import { getServiceClient } from "@/lib/supabase";
import StudentsClient from "./StudentsClient";
import PageIntro from "@/components/shared/PageIntro";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, scopeIds, scopeUsers } from "@/lib/qa";

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

  // Class names per student (only groups visible to this viewer side).
  const nameById = new Map(classGroups.map((g) => [g.id as string, g.name as string]));
  const classesByStudent: Record<string, string[]> = {};
  if (students.length > 0 && nameById.size > 0) {
    const { data: members } = await getServiceClient()
      .from("class_group_members")
      .select("student_id, class_group_id")
      .in("student_id", students.map((s) => s.id as string));
    for (const m of members ?? []) {
      const name = nameById.get(m.class_group_id as string);
      if (!name) continue;
      (classesByStudent[m.student_id as string] ??= []).push(name);
    }
  }
  const withClasses = students.map((s) => ({
    ...s,
    classes: (classesByStudent[s.id as string] ?? []).sort(),
  }));

  return (
    <>
      <PageIntro tKey="admin.students" />
      <StudentsClient students={withClasses} classGroups={classGroups} />
    </>
  );
}
