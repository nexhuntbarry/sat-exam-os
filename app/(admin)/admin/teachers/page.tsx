import { clerkClient } from "@clerk/nextjs/server";
import { getServiceClient } from "@/lib/supabase";
import TeachersClient from "./TeachersClient";
import PageIntro from "@/components/shared/PageIntro";
import { getCurrentUser } from "@/lib/auth";
import { scopeUsers } from "@/lib/qa";

async function getTeachers(viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data } = await scopeUsers(db
    .from("users")
    .select(`id, email, display_name, account_status, created_at, clerk_user_id, can_review_questions, teacher_profiles!teacher_profiles_user_id_fkey(assigned_classes, bio, specialty)`)
    .eq("role", "teacher"), viewerIsQa)
    .order("created_at", { ascending: false });
  const teachers = data ?? [];

  const clerkIds = teachers
    .map((t) => t.clerk_user_id as string | null)
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
      console.error("[teachers] Clerk getUserList failed:", err);
    }
  }

  return teachers.map((t) => ({
    ...t,
    last_sign_in_at: t.clerk_user_id ? lastSignInById[t.clerk_user_id as string] ?? null : null,
  }));
}

export default async function TeachersPage() {
  const teachers = await getTeachers((await getCurrentUser())?.isQa ?? false);
  return (
    <>
      <PageIntro tKey="admin.teachers" />
      <TeachersClient teachers={teachers} />
    </>
  );
}
