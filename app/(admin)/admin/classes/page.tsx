import { getServiceClient } from "@/lib/supabase";
import ClassesClient from "./ClassesClient";
import PageIntro from "@/components/shared/PageIntro";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, scopeIds } from "@/lib/qa";

async function getClassGroups(viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data } = await scopeIds(db
    .from("class_groups")
    .select(`id, name, campus, grade, created_at, class_group_members(id)`), "id", await getQaClassGroupIds(), viewerIsQa)
    .order("created_at", { ascending: false });
  return (data ?? []).map((cg) => ({
    ...cg,
    memberCount: Array.isArray(cg.class_group_members)
      ? cg.class_group_members.length
      : 0,
  }));
}

export default async function ClassesPage() {
  const classGroups = await getClassGroups((await getCurrentUser())?.isQa ?? false);
  return (
    <>
      <PageIntro tKey="admin.classes" />
      <ClassesClient classGroups={classGroups} />
    </>
  );
}
