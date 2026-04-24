import { getServiceClient } from "@/lib/supabase";
import TeachersClient from "./TeachersClient";

async function getTeachers() {
  const db = getServiceClient();
  const { data } = await db
    .from("users")
    .select(`id, email, display_name, account_status, created_at, teacher_profiles(assigned_classes, bio, specialty)`)
    .eq("role", "teacher")
    .order("created_at", { ascending: false });
  return data ?? [];
}

export default async function TeachersPage() {
  const teachers = await getTeachers();
  return <TeachersClient teachers={teachers} />;
}
