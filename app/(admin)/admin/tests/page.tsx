import { getServiceClient } from "@/lib/supabase";
import Link from "next/link";
import { Plus, ClipboardList } from "lucide-react";
import { clsx } from "clsx";

async function getTests() {
  const db = getServiceClient();
  const { data: tests } = await db
    .from("tests")
    .select(`
      id, test_name, status, open_date, due_date, created_at,
      modules!inner(module_name, section, module_number)
    `)
    .order("created_at", { ascending: false });

  if (!tests || tests.length === 0) return [];

  const testIds = tests.map((t) => t.id);

  const [{ data: assignments }, { data: submissions }] = await Promise.all([
    db.from("test_assignments").select("test_id, teacher_ids, student_ids, class_group_ids").in("test_id", testIds),
    db.from("submissions").select("test_id, status").in("test_id", testIds),
  ]);

  const assignMap: Record<string, { teachers: number; students: number }> = {};
  for (const a of assignments ?? []) {
    assignMap[a.test_id] = {
      teachers: (a.teacher_ids ?? []).length,
      students: (a.student_ids ?? []).length,
    };
  }

  const subMap: Record<string, { done: number; total: number }> = {};
  for (const s of submissions ?? []) {
    if (!subMap[s.test_id]) subMap[s.test_id] = { done: 0, total: 0 };
    subMap[s.test_id].total++;
    if (s.status === "Submitted" || s.status === "Late") subMap[s.test_id].done++;
  }

  return tests.map((t) => ({
    ...t,
    assignment: assignMap[t.id] ?? { teachers: 0, students: 0 },
    submissions: subMap[t.id] ?? { done: 0, total: 0 },
  }));
}

const statusStyles: Record<string, string> = {
  Draft: "bg-white/10 text-soft-gray/60",
  Published: "bg-lime-green/15 text-lime-green",
  Closed: "bg-rose/15 text-rose",
};

export default async function TestsPage() {
  const tests = await getTests();

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Tests</h1>
        <Link
          href="/admin/tests/new"
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm transition-colors"
        >
          <Plus size={16} />
          Create Test
        </Link>
      </div>

      <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
        {tests.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <ClipboardList size={40} className="text-soft-gray/20 mx-auto" />
            <p className="text-soft-gray/40 text-sm">
              No tests yet.{" "}
              <Link href="/admin/tests/new" className="text-electric-blue hover:underline">
                Create your first test
              </Link>
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-soft-gray/50">
                  <th className="text-left px-5 py-3 font-medium">Test Name</th>
                  <th className="text-left px-5 py-3 font-medium">Module</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Assignments</th>
                  <th className="text-left px-5 py-3 font-medium">Submissions</th>
                  <th className="text-left px-5 py-3 font-medium">Due Date</th>
                  <th className="text-left px-5 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((test) => {
                  const mod = test.modules as unknown as { module_name: string; section: string; module_number: number | null };
                  return (
                    <tr
                      key={test.id}
                      className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors"
                    >
                      <td className="px-5 py-3">
                        <Link href={`/admin/tests/${test.id}`} className="hover:text-electric-blue transition-colors">
                          <div className="font-medium text-white">{test.test_name}</div>
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {mod.module_name}
                        <div className="text-xs text-soft-gray/40">
                          {mod.section}{mod.module_number ? ` · M${mod.module_number}` : ""}
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx("px-2 py-1 rounded-full text-xs font-medium", statusStyles[test.status] ?? "bg-white/10 text-soft-gray/60")}>
                          {test.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {test.assignment.teachers}T · {test.assignment.students}S
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {test.submissions.done} / {test.submissions.total}
                      </td>
                      <td className="px-5 py-3 text-soft-gray/50 text-xs">
                        {test.due_date ? new Date(test.due_date).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-5 py-3">
                        <Link
                          href={`/admin/tests/${test.id}`}
                          className="text-xs text-electric-blue hover:underline"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
