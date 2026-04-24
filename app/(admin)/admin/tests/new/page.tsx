import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import CreateTestClient from "./CreateTestClient";

async function getData() {
  const db = getServiceClient();

  const [{ data: modules }, { data: teachers }, { data: students }, { data: classGroups }] = await Promise.all([
    db.from("modules")
      .select("id, module_name, section, module_number, parsing_status, total_questions")
      .order("module_name"),
    db.from("users")
      .select("id, display_name, email")
      .eq("role", "teacher")
      .eq("account_status", "approved")
      .order("display_name"),
    db.from("users")
      .select("id, display_name, email")
      .eq("role", "student")
      .eq("account_status", "approved")
      .order("display_name"),
    db.from("class_groups")
      .select("id, name, campus, grade")
      .order("name"),
  ]);

  return {
    modules: modules ?? [],
    teachers: teachers ?? [],
    students: students ?? [],
    classGroups: classGroups ?? [],
  };
}

export default async function NewTestPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const data = await getData();

  return <CreateTestClient {...data} />;
}
