import { getServiceClient } from "@/lib/supabase";
import { summarizeTestProgress } from "@/lib/test-progress";
import Link from "next/link";
import { Plus, ClipboardList } from "lucide-react";
import { clsx } from "clsx";
import { sectionTitleClass } from "@/lib/section-color";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, scopeIds, scopeUsers } from "@/lib/qa";
import AssignDialog from "./[id]/AssignDialog";

async function getTests(viewerIsQa: boolean) {
  const db = getServiceClient();
  const { data: tests } = await scopeIds(db
    .from("tests")
    .select(`
      id, test_name, status, open_date, due_date, created_at,
      is_adaptive, module_2_id,
      modules!module_id(module_name, section, module_number)
    `), "id", await getQaTestIds(), viewerIsQa)
    .order("created_at", { ascending: false });

  if (!tests || tests.length === 0) return [];

  const testIds = tests.map((t) => t.id);

  const [{ data: assignments }, { data: submissions }] = await Promise.all([
    db.from("test_assignments").select("test_id, teacher_ids, student_ids, class_group_ids").in("test_id", testIds),
    db.from("submissions").select("test_id, student_id, status, session_id, adaptive_track, started_at").in("test_id", testIds),
  ]);

  const assignMap: Record<string, { teacherIds: string[]; studentIds: string[]; classGroupIds: string[] }> = {};
  for (const a of assignments ?? []) {
    assignMap[a.test_id] = {
      teacherIds: (a.teacher_ids ?? []) as string[],
      studentIds: (a.student_ids ?? []) as string[],
      classGroupIds: (a.class_group_ids ?? []) as string[],
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
      (submissions ?? []).filter((s) => s.test_id === t.id),
      assigned,
      Boolean((t as { module_2_id?: string | null }).module_2_id || t.is_adaptive),
    );
    subMap[t.id] = { done: p.finished, total: p.students };
  }

  return tests.map((t) => ({
    ...t,
    assignment: assignMap[t.id] ?? { teacherIds: [], studentIds: [], classGroupIds: [] },
    submissions: subMap[t.id] ?? { done: 0, total: 0 },
  }));
}

const statusStyles: Record<string, string> = {
  Draft: "bg-light-bg text-mid-gray",
  Published: "bg-warm-amber/15 text-warm-amber",
  Closed: "bg-status-error/15 text-status-error",
};

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

  // Closed tests sink into a collapsed section at the bottom so the
  // list shows what's live by default.
  const activeTests = tests.filter((t) => t.status !== "Closed");
  const closedTests = tests.filter((t) => t.status === "Closed");
  const renderTable = (rows: typeof tests) => (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">Test Name</th>
                  <th className="text-left px-5 py-3 font-medium">Module</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Assignments</th>
                  <th className="text-left px-5 py-3 font-medium">Finished</th>
                  <th className="text-left px-5 py-3 font-medium">Due Date</th>
                  <th className="text-left px-5 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((test) => {
                  // Adaptive tests have no `tests.module_id`; the join
                  // is now LEFT and may return null. Fall back to a
                  // placeholder for the table column rather than
                  // dereferencing undefined.
                  const mod = test.modules as unknown as
                    | { module_name: string; section: string; module_number: number | null }
                    | null;
                  return (
                    <tr
                      key={test.id}
                      className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                    >
                      <td className="px-5 py-3">
                        <Link href={`/admin/tests/${test.id}`} className="hover:text-warm-coral-text transition-colors">
                          <div className={clsx("font-medium", sectionTitleClass(mod?.section))}>{test.test_name}</div>
                          {test.is_adaptive && (
                            <span className="text-[10px] uppercase tracking-wider text-warm-coral-text font-semibold">Adaptive</span>
                          )}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {mod ? (
                          <>
                            {mod.module_name}
                            <div className="text-xs text-soft-mute">
                              {mod.section}{mod.module_number ? ` · M${mod.module_number}` : ""}
                            </div>
                          </>
                        ) : (
                          <span className="text-soft-mute italic text-xs">Adaptive · multi-module</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx("px-2 py-1 rounded-full text-xs font-medium", statusStyles[test.status] ?? "bg-light-bg text-mid-gray")}>
                          {test.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-mid-gray whitespace-nowrap" title="Teachers · Students · Class groups">
                        {test.assignment.teacherIds.length}T · {test.assignment.studentIds.length}S · {test.assignment.classGroupIds.length}C
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {test.submissions.done} / {test.submissions.total}
                      </td>
                      <td className="px-5 py-3 text-soft-mute text-xs">
                        {test.due_date ? formatDate(test.due_date) : "—"}
                      </td>
                      <td className="px-5 py-3">
                        <AssignDialog
                          variant="menu"
                          testId={test.id}
                          studentIds={test.assignment.studentIds}
                          classGroupIds={test.assignment.classGroupIds}
                          teacherIds={test.assignment.teacherIds}
                          allClassGroups={assignOptions.allClassGroups}
                          allTeachers={assignOptions.allTeachers}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
  );

  return (
    <div className="max-w-6xl mx-auto space-y-6">
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

      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {tests.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <ClipboardList size={40} className="text-charcoal/20 mx-auto" />
            <p className="text-soft-mute text-sm">
              No tests yet.{" "}
              <Link href="/admin/tests/new" className="text-warm-coral-text hover:underline">
                Create your first test
              </Link>
            </p>
          </div>
        ) : (
          <>
            {activeTests.length > 0 && renderTable(activeTests)}
            {closedTests.length > 0 && (
              <details className="border-t border-divider">
                <summary className="px-5 py-3 text-sm text-soft-mute cursor-pointer hover:text-charcoal select-none">
                  Closed tests ({closedTests.length})
                </summary>
                {renderTable(closedTests)}
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
