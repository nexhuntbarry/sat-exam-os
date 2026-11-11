import { getServiceClient } from "@/lib/supabase";
import { childTestIds, fullLengthLinksOrNone } from "@/lib/full-length";
import { notFound } from "next/navigation";
import ClassDetailClient from "./ClassDetailClient";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, onSide, scopeUsers } from "@/lib/qa";
import type { AssignedTest } from "./ClassDetailClient";
import type { AvailableTest } from "./AssignTestButton";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { loadClassGradebook } from "@/lib/class-gradebook";
import type { Gradebook } from "@/lib/class-gradebook-view";

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
  const { data } = await fetchAllRows<{
    id: string;
    student_id: string;
    users: {
      id: string;
      email: string;
      display_name: string | null;
      student_profiles: { grade: string | null; school: string | null }[] | null;
    }[] | null;
  }>((from, to) =>
    db
      .from("class_group_members")
      .select(`id, student_id, users(id, email, display_name, student_profiles(grade, school))`)
      .eq("class_group_id", classGroupId)
      .order("id")
      .range(from, to),
  );
  // Supabase returns arrays for joins; normalize to expected shape
  return (data ?? []).map((r) => {
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

async function getAllStudentsForPicker(viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data } = await fetchAllRows((from, to) =>
    scopeUsers(
      db
        .from("users")
        .select("id, email, display_name, account_status, student_profiles(grade, school)")
        .eq("role", "student"),
      viewerIsQa,
    ).order("display_name").order("id").range(from, to),
  );

  type RawRow = {
    id: string;
    email: string;
    display_name: string | null;
    account_status: string;
    student_profiles:
      | { grade: string | null; school: string | null }[]
      | { grade: string | null; school: string | null }
      | null;
  };

  return (data ?? []).map((s) => {
    const row = s as unknown as RawRow;
    const profile = Array.isArray(row.student_profiles)
      ? (row.student_profiles[0] ?? null)
      : (row.student_profiles ?? null);
    return {
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      account_status: row.account_status ?? "approved",
      grade: profile?.grade ?? null,
      school: profile?.school ?? null,
    };
  });
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
    .contains("class_group_ids", JSON.stringify([classGroupId]));
  return (data ?? []).map((row) => {
    const t = Array.isArray(row.tests) ? row.tests[0] : row.tests;
    return { id: row.test_id as string, name: ((t as { test_name?: string } | null)?.test_name ?? "Untitled test") };
  });
}

// Test cards for the "Assigned Tests" section. Progress ("x/y submitted ·
// Avg SAT") is read from the Scores gradebook's columns, so the two always
// agree: each student counts once, with their latest finished attempt
// (a retake in progress keeps the earlier score), full-length SATs by
// their 400–1600 total. `gradebook` null (it failed to load) = progress
// unknown.
async function getAssignedTests(
  classGroupId: string,
  viewerIsQa: boolean,
  gradebook: Gradebook | null,
): Promise<AssignedTest[]> {
  const db = getServiceClient();
  const { data, error } = await db
    .from("test_assignments")
    .select("test_id, tests(id, test_name, open_date, due_date, status, modules!module_id(section))")
    .contains("class_group_ids", JSON.stringify([classGroupId]));
  if (error) console.error("[classes/assigned-tests] lookup error:", error);

  if (!data || data.length === 0) return [];

  // Scope to the viewer's QA side (real admin sees only real tests, QA only QA tests).
  const qaTestIds = await getQaTestIds();
  const visibleRows = data.filter((row) => onSide(row.test_id as string, qaTestIds, viewerIsQa));
  if (visibleRows.length === 0) return [];

  const flLinks = await fullLengthLinksOrNone(db);
  const columnOf = new Map((gradebook?.columns ?? []).map((c) => [c.id, c]));

  return visibleRows.map((row) => {
    const t = Array.isArray(row.tests) ? row.tests[0] : row.tests;
    type TestMeta = {
      test_name?: string;
      open_date?: string | null;
      due_date?: string | null;
      status?: string;
      modules?: { section?: string } | { section?: string }[] | null;
    };
    const tMeta = (t as TestMeta | null) ?? null;
    const mod = tMeta?.modules;
    const modObj = Array.isArray(mod) ? mod[0] : mod;
    const fl = flLinks.childrenOf.has(row.test_id as string);
    const col = columnOf.get(row.test_id as string);
    return {
      id: row.test_id as string,
      name: tMeta?.test_name ?? "Untitled test",
      section: fl ? "Full-length SAT" : ((modObj as { section?: string } | null | undefined)?.section ?? null),
      openDate: tMeta?.open_date ?? null,
      dueDate: tMeta?.due_date ?? null,
      status: tMeta?.status ?? null,
      progress: gradebook
        ? {
            submitted: col?.submitted ?? 0,
            inProgress: col?.inProgress ?? 0,
            total: gradebook.rows.length,
            avgScore: col?.avgPct ?? null,
            avgSat: col?.avg ?? null,
          }
        : null,
    };
  });
}

// All tests visible on this side — used to populate the "Assign test" picker.
// Fetches the test_assignments row to get the current class_group_ids so the
// picker can show which tests are already assigned to this class.
async function getAllTests(viewerIsQa: boolean): Promise<AvailableTest[]> {
  const db = getServiceClient();
  const qaTestIds = await getQaTestIds();
  // Full-length SAT sections are assigned through their parent only.
  const flChildren = await childTestIds(db);

  const [{ data: tests }, { data: assignments }] = await Promise.all([
    fetchAllRows((from, to) =>
      db
        .from("tests")
        .select("id, test_name, status, open_date, due_date, modules!module_id(section)")
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      db.from("test_assignments").select("test_id, class_group_ids").order("test_id").range(from, to),
    ),
  ]);

  const assignMap = new Map(
    (assignments ?? []).map((a) => [
      a.test_id as string,
      { classGroupIds: (a.class_group_ids as string[]) ?? [] },
    ]),
  );

  return (tests ?? [])
    .filter((t) => onSide(t.id as string, qaTestIds, viewerIsQa) && !flChildren.has(t.id as string))
    .map((t) => {
      const mod = Array.isArray(t.modules) ? t.modules[0] : t.modules;
      const a = assignMap.get(t.id as string);
      return {
        id: t.id as string,
        name: (t.test_name as string) ?? "Untitled test",
        section: ((mod as { section?: string } | null)?.section) ?? null,
        status: (t.status as string | null) ?? null,
        openDate: (t.open_date as string | null) ?? null,
        dueDate: (t.due_date as string | null) ?? null,
        currentClassGroupIds: a?.classGroupIds ?? [],
      } satisfies AvailableTest;
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
  const [classGroup, members, allStudents, allTeachers, assignedTeachers, linkedTests, availableTests] = await Promise.all([
    getClassGroup(id),
    getMembers(id),
    getAllStudentsForPicker(isQa),
    getAllTeachers(isQa),
    getAssignedTeachers(id),
    getLinkedTests(id),
    getAllTests(isQa),
  ]);

  if (!classGroup) notFound();

  // A failed gradebook read must not take the class page down: Scores
  // shows a notice and Assigned Tests shows progress as unknown.
  const gradebook = await loadClassGradebook(getServiceClient(), {
    classGroupId: id,
    isQa,
    subjects: null,
    testHref: (testId) => `/admin/tests/${testId}/submissions?class=${id}`,
  }).catch((e) => {
    console.error("[classes/gradebook] load failed:", e);
    return null;
  });
  const assignedTests = await getAssignedTests(id, isQa, gradebook);

  return (
    <ClassDetailClient
      classGroup={classGroup}
      members={members}
      allStudents={allStudents}
      allTeachers={allTeachers}
      assignedTeachers={assignedTeachers}
      linkedTests={linkedTests}
      assignedTests={assignedTests}
      gradebook={gradebook}
      availableTests={availableTests}
    />
  );
}
