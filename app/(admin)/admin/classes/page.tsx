import { getServiceClient } from "@/lib/supabase";
import ClassesClient from "./ClassesClient";

async function getClassGroups() {
  const db = getServiceClient();
  const { data } = await db
    .from("class_groups")
    .select(`id, name, campus, grade, created_at, class_group_members(id)`)
    .order("created_at", { ascending: false });
  return (data ?? []).map((cg) => ({
    ...cg,
    memberCount: Array.isArray(cg.class_group_members)
      ? cg.class_group_members.length
      : 0,
  }));
}

export default async function ClassesPage() {
  const classGroups = await getClassGroups();
  return <ClassesClient classGroups={classGroups} />;
}
