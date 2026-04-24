import { getServiceClient } from "@/lib/supabase";
import { notFound } from "next/navigation";
import ClassDetailClient from "./ClassDetailClient";

async function getClassGroup(id: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("class_groups")
    .select("id, name, campus, grade")
    .eq("id", id)
    .single();
  return data;
}

interface MemberRow {
  id: string;
  student_id: string;
  users: {
    id: string;
    email: string;
    display_name: string | null;
    student_profiles: { grade: string | null; school: string | null } | null;
  } | null;
}

async function getMembers(classGroupId: string): Promise<MemberRow[]> {
  const db = getServiceClient();
  const { data } = await db
    .from("class_group_members")
    .select(`id, student_id, users(id, email, display_name, student_profiles(grade, school))`)
    .eq("class_group_id", classGroupId);
  // Supabase returns arrays for joins; normalize to expected shape
  const rows = (data ?? []) as unknown as {
    id: string;
    student_id: string;
    users: {
      id: string;
      email: string;
      display_name: string | null;
      student_profiles: { grade: string | null; school: string | null }[] | null;
    }[] | null;
  }[];
  return rows.map((r) => {
    const u = Array.isArray(r.users) ? r.users[0] ?? null : r.users ?? null;
    return {
      id: r.id,
      student_id: r.student_id,
      users: u
        ? {
            id: u.id,
            email: u.email,
            display_name: u.display_name,
            student_profiles: Array.isArray(u.student_profiles)
              ? u.student_profiles[0] ?? null
              : u.student_profiles,
          }
        : null,
    };
  });
}

async function getApprovedStudents() {
  const db = getServiceClient();
  const { data } = await db
    .from("users")
    .select("id, email, display_name")
    .eq("role", "student")
    .eq("account_status", "approved")
    .order("display_name");
  return data ?? [];
}

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [classGroup, members, allStudents] = await Promise.all([
    getClassGroup(id),
    getMembers(id),
    getApprovedStudents(),
  ]);

  if (!classGroup) notFound();

  return (
    <ClassDetailClient
      classGroup={classGroup}
      members={members}
      allStudents={allStudents}
    />
  );
}
