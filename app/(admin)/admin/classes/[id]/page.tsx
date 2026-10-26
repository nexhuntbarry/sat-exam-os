import { getServiceClient } from "@/lib/supabase";
import { notFound } from "next/navigation";
import ClassDetailClient from "./ClassDetailClient";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, onSide, scopeUsers } from "@/lib/qa";

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

async function getApprovedStudents(viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data } = await scopeUsers(db
    .from("users")
    .select("id, email, display_name")
    .eq("role", "student")
    .eq("account_status", "approved"), viewerIsQa)
    .order("display_name");
  return data ?? [];
}

async function getAllTeachers(viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data } = await scopeUsers(db
    .from("users")
    .select("id, email, display_name, can_review_questions")
    .eq("role", "teacher")
    .eq("account_status", "approved"), viewerIsQa)
    .order("display_name");
  return data ?? [];
}

async function getAssignedTeachers(classGroupId: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("class_group_teachers")
    // class_group_teachers has two FKs to users (teacher_id +
    // assigned_by). Disambiguate so PostgREST embeds the right one.
    .select(`teacher_id, assigned_at, subject, users!teacher_id(id, email, display_name, can_review_questions)`)
    .eq("class_group_id", classGroupId);
  return (data ?? []).map((row) => {
    const u = Array.isArray(row.users) ? row.users[0] : row.users;
    return {
      id: u.id as string,
      email: u.email as string,
      display_name: (u.display_name ?? null) as string | null,
      can_review_questions: Boolean(u.can_review_questions),
      assigned_at: row.assigned_at as string,
      subject: (row.subject ?? null) as string | null,
    };
  });
}

// Tests that list this class in test_assignments.class_group_ids — shown
// in the delete confirmation so the admin knows what loses the class.
async function getLinkedTests(classGroupId: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("test_assignments")
    .select("test_id, tests(test_name)")
    .contains("class_group_ids", [classGroupId]);
  return (data ?? []).map((row) => {
    const t = Array.isArray(row.tests) ? row.tests[0] : row.tests;
    return { id: row.test_id as string, name: ((t as { test_name?: string } | null)?.test_name ?? "Untitled test") };
  });
}

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const isQa = (await getCurrentUser())?.isQa ?? false;
  if (!onSide(id, await getQaClassGroupIds(), isQa)) notFound();
  const [classGroup, members, allStudents, allTeachers, assignedTeachers, linkedTests] = await Promise.all([
    getClassGroup(id),
    getMembers(id),
    getApprovedStudents(isQa),
    getAllTeachers(isQa),
    getAssignedTeachers(id),
    getLinkedTests(id),
  ]);

  if (!classGroup) notFound();

  return (
    <ClassDetailClient
      classGroup={classGroup}
      members={members}
      allStudents={allStudents}
      allTeachers={allTeachers}
      assignedTeachers={assignedTeachers}
      linkedTests={linkedTests}
    />
  );
}
