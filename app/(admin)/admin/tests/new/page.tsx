import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import CreateTestClient from "./CreateTestClient";
import { getQaClassGroupIds, scopeIds, scopeUsers } from "@/lib/qa";
import { approvalCounts } from "../module-approval";

async function getData(viewerIsQa: boolean) {
  const qaGroups = await getQaClassGroupIds();
  const db = getServiceClient();

  const [{ data: modules }, { data: teachers }, { data: students }, { data: classGroups }] = await Promise.all([
    db.from("modules")
      .select("id, module_name, section, module_number, parsing_status, total_questions, questions:questions!module_id(parsing_status)")
      .order("module_name"),
    scopeUsers(db.from("users")
      .select("id, display_name, email")
      .eq("role", "teacher")
      .eq("account_status", "approved"), viewerIsQa)
      .order("display_name"),
    scopeUsers(db.from("users")
      .select("id, display_name, email")
      .eq("role", "student")
      .eq("account_status", "approved"), viewerIsQa)
      .order("display_name"),
    scopeIds(db.from("class_groups")
      .select("id, name, campus, grade"), "id", qaGroups, viewerIsQa)
      .order("name"),
  ]);

  return {
    modules: (modules ?? []).map(({ questions, ...m }) => {
      const counts = approvalCounts(questions as { parsing_status: string }[] | null);
      return { ...m, approved: counts.approved, approvalTotal: counts.total };
    }),
    teachers: teachers ?? [],
    students: students ?? [],
    classGroups: classGroups ?? [],
  };
}

export default async function NewTestPage() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const data = await getData(user.isQa);

  return <CreateTestClient {...data} />;
}
