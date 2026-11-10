import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import CreateTestClient from "./CreateTestClient";
import { getQaClassGroupIds, scopeIds, scopeUsers } from "@/lib/qa";
import { fullLengthEnabledFor } from "@/lib/full-length-admin";
import { approvalCounts } from "../module-approval";
import { getFullLengthSources } from "../full-length-sources";

async function getData(viewerIsQa: boolean) {
  const qaGroups = await getQaClassGroupIds();
  const db = getServiceClient();

  const [{ data: modules }, { data: teachers }, { data: students }, { data: classGroups }, fullLengthEnabled] = await Promise.all([
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
    fullLengthEnabledFor(db, { isQa: viewerIsQa }),
  ]);

  const moduleRows = (modules ?? []).map(({ questions, ...m }) => {
    const counts = approvalCounts(questions as { parsing_status: string }[] | null);
    return { ...m, approved: counts.approved, approvalTotal: counts.total };
  });

  return {
    modules: moduleRows,
    fullLengthEnabled,
    fullLengthSources: fullLengthEnabled ? await getFullLengthSources(viewerIsQa, moduleRows) : [],
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
