import { Suspense } from "react";
import { getServiceClient } from "@/lib/supabase";
import { summarizeTestProgress } from "@/lib/test-progress";
import Link from "next/link";
import { Plus, ClipboardList } from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, scopeIds, scopeUsers } from "@/lib/qa";
import { asParentRows, expandWithChildren, fullLengthLinksOrNone, hideChildTests } from "@/lib/full-length";
import TestsTableClient, { type TestRow } from "./TestsTableClient";

async function getTests(viewerIsQa: boolean): Promise<TestRow[]> {
  const db = getServiceClient();
  const flLinks = await fullLengthLinksOrNone(db);
  const { data: tests } = await hideChildTests(scopeIds(db
    .from("tests")
    .select(`
      id, test_name, status, open_date, due_date, created_at,
      is_adaptive, module_2_id,
      modules!module_id(module_name, section, module_number),
      module_2:modules!module_2_id(module_name, module_number)
    `), "id", await getQaTestIds(), viewerIsQa), new Set(flLinks.parentOf.keys()))
    .order("created_at", { ascending: false });

  if (!tests || tests.length === 0) return [];

  const testIds = tests.map((t) => t.id);

  const [{ data: assignments }, { data: submissions }] = await Promise.all([
    db.from("test_assignments").select("test_id, teacher_ids, student_ids, class_group_ids").in("test_id", testIds),
    db.from("submissions").select("test_id, student_id, status, session_id, adaptive_track, started_at, attempt_number").in("test_id", expandWithChildren(testIds, flLinks)),
  ]);
  // A full-length SAT's rows are on its children: one attempt under the parent.
  const progressRows = asParentRows(submissions ?? [], flLinks);

  // Student names for the Assignments hover.
  const assignedStudentIds = [...new Set((assignments ?? []).flatMap((a) => (a.student_ids ?? []) as string[]))];
  const { data: studentUsers } = assignedStudentIds.length > 0
    ? await db.from("users").select("id, display_name, email").in("id", assignedStudentIds)
    : { data: [] as { id: string; display_name: string | null; email: string }[] };
  const studentName = new Map((studentUsers ?? []).map((u) => [u.id, u.display_name || u.email]));

  const assignMap: Record<string, TestRow["assignment"]> = {};
  for (const a of assignments ?? []) {
    assignMap[a.test_id] = {
      teacherIds: (a.teacher_ids ?? []) as string[],
      studentIds: (a.student_ids ?? []) as string[],
      classGroupIds: (a.class_group_ids ?? []) as string[],
      studentNames: ((a.student_ids ?? []) as string[]).map((id) => studentName.get(id) ?? "Unknown student"),
    };
  }

  // Count students, not module rows: a Module 1 + Module 2 test has two
  // submission rows per student, and class-assigned students count too.
  const groupIds = [...new Set((assignments ?? []).flatMap((a) => (a.class_group_ids ?? []) as string[]))];
  const { data: members } = groupIds.length > 0
    ? await db.from("class_group_members").select("class_group_id, student_id").in("class_group_id", groupIds)
    : { data: [] as { class_group_id: string; student_id: string }[] };
  const subMap: Record<string, { done: number; total: number }> = {};
  for (const t of tests) {
    const a = (assignments ?? []).find((x) => x.test_id === t.id);
    const groups = new Set((a?.class_group_ids ?? []) as string[]);
    const assigned = [
      ...((a?.student_ids ?? []) as string[]),
      ...(members ?? []).filter((m) => groups.has(m.class_group_id)).map((m) => m.student_id),
    ];
    const p = summarizeTestProgress(
      progressRows.filter((s) => s.test_id === t.id),
      assigned,
      Boolean((t as { module_2_id?: string | null }).module_2_id || t.is_adaptive) || flLinks.childrenOf.has(t.id),
    );
    subMap[t.id] = { done: p.finished, total: p.students };
  }

  const flSections = await fullLengthSourceNames(db, testIds.filter((id) => flLinks.childrenOf.has(id)));

  return tests.map((t) => ({
    id: t.id,
    test_name: t.test_name,
    status: t.status,
    due_date: t.due_date ?? null,
    created_at: t.created_at,
    is_adaptive: t.is_adaptive,
    modules: t.modules,
    module_2: (t as { module_2?: unknown }).module_2 ?? null,
    assignment: assignMap[t.id] ?? { teacherIds: [], studentIds: [], classGroupIds: [], studentNames: [] },
    submissions: subMap[t.id] ?? { done: 0, total: 0 },
    fullLength: flLinks.childrenOf.has(t.id) ? flSections.get(t.id) ?? { rw: null, math: null } : null,
  }));
}

// Full-length SAT parents: the source test each section was built from
// (display only; null when the source was deleted or on a lookup error).
async function fullLengthSourceNames(
  db: ReturnType<typeof getServiceClient>,
  parentIds: string[],
): Promise<Map<string, { rw: string | null; math: string | null }>> {
  const out = new Map<string, { rw: string | null; math: string | null }>();
  if (parentIds.length === 0) return out;
  const { data: kids, error } = await db
    .from("tests")
    .select("parent_test_id, section_order, source_test_id")
    .in("parent_test_id", parentIds);
  if (error) return out;
  const rows = (kids ?? []) as { parent_test_id: string; section_order: number; source_test_id: string | null }[];
  const sourceIds = [...new Set(rows.map((r) => r.source_test_id).filter((x): x is string => Boolean(x)))];
  const { data: sources } = sourceIds.length > 0
    ? await db.from("tests").select("id, test_name").in("id", sourceIds)
    : { data: [] as { id: string; test_name: string }[] };
  const nameOf = new Map((sources ?? []).map((t) => [t.id as string, t.test_name as string]));
  for (const r of rows) {
    const entry = out.get(r.parent_test_id) ?? { rw: null, math: null };
    const name = r.source_test_id ? nameOf.get(r.source_test_id) ?? null : null;
    if (r.section_order === 1) entry.rw = name;
    else entry.math = name;
    out.set(r.parent_test_id, entry);
  }
  return out;
}

// Teachers and class groups the Assign dialogs can pick from — same
// QA-scoped lists as the test detail page.
async function getAssignOptions(viewerIsQa: boolean) {
  const db = getServiceClient();
  const qaGroups = await getQaClassGroupIds();
  const [{ data: allTeachers }, { data: allClassGroups }] = await Promise.all([
    scopeUsers(db.from("users").select("id, display_name, email").eq("role", "teacher"), viewerIsQa).order("display_name"),
    scopeIds(db.from("class_groups").select("id, name, campus, grade"), "id", qaGroups, viewerIsQa).order("name"),
  ]);
  return { allTeachers: allTeachers ?? [], allClassGroups: allClassGroups ?? [] };
}

export default async function TestsPage() {
  const viewerIsQa = (await getCurrentUser())?.isQa ?? false;
  const [tests, assignOptions] = await Promise.all([getTests(viewerIsQa), getAssignOptions(viewerIsQa)]);

  return (
    <div className="space-y-6">
      <PageIntro tKey="admin.tests" />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal">Tests</h1>
        <Link
          href="/admin/tests/new"
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
        >
          <Plus size={16} />
          Create Test
        </Link>
      </div>

      {tests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-divider py-16 text-center space-y-3">
          <ClipboardList size={40} className="text-charcoal/20 mx-auto" />
          <p className="text-soft-mute text-sm">
            No tests yet.{" "}
            <Link href="/admin/tests/new" className="text-warm-coral-text hover:underline">
              Create your first test
            </Link>
          </p>
        </div>
      ) : (
        <Suspense fallback={<div className="py-8 text-center text-soft-mute text-sm">Loading…</div>}>
          <TestsTableClient tests={tests} assignOptions={assignOptions} />
        </Suspense>
      )}
    </div>
  );
}

