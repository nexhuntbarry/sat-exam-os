import { getServiceClient } from "@/lib/supabase";
import StudentsClient from "./StudentsClient";

async function getStudents(status: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("users")
    .select(
      `id, email, display_name, account_status, created_at,
       student_profiles(grade, school, campus, class_group, parent_name, parent_email, parent_phone, target_score, current_level, status_reason)`
    )
    .eq("role", "student")
    .eq("account_status", status)
    .order("created_at", { ascending: false });
  return data ?? [];
}

async function getClassGroups() {
  const db = getServiceClient();
  const { data } = await db
    .from("class_groups")
    .select("id, name, campus, grade")
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

  const [students, classGroups] = await Promise.all([
    getStudents(validTab),
    getClassGroups(),
  ]);

  return <StudentsClient students={students} classGroups={classGroups} tab={validTab} />;
}
