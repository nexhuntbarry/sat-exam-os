import { clerkClient } from "@clerk/nextjs/server";
import { getServiceClient } from "@/lib/supabase";
import StudentsClient from "./StudentsClient";
import PageIntro from "@/components/shared/PageIntro";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, scopeIds, scopeUsers } from "@/lib/qa";

async function getStudents(status: string, viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data } = await scopeUsers(db
    .from("users")
    .select(
      `id, email, display_name, account_status, created_at, clerk_user_id,
       student_profiles(grade, school, campus, class_group, parent_name, parent_email, parent_phone, target_score, current_level, status_reason)`
    )
    .eq("role", "student")
    .eq("account_status", status), viewerIsQa)
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

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab = "pending" } = await searchParams;
  const validTab = ["pending", "approved", "suspended"].includes(tab) ? tab : "pending";

  const isQa = (await getCurrentUser())?.isQa ?? false;
  const [students, classGroups] = await Promise.all([
    getStudents(validTab, isQa),
    getClassGroups(isQa),
  ]);

  return (
    <>
      <PageIntro tKey="admin.students" />
      <StudentsClient students={students} classGroups={classGroups} tab={validTab} />
    </>
  );
}
