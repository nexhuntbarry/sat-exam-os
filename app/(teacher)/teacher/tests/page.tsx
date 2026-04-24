import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { clsx } from "clsx";

async function getTeacherTests(teacherId: string) {
  const db = getServiceClient();

  const { data: assignments } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids")
    .contains("teacher_ids", JSON.stringify([teacherId]));

  if (!assignments || assignments.length === 0) return [];

  const testIds = assignments.map((a) => a.test_id);

  const [{ data: tests }, { data: subData }] = await Promise.all([
    db.from("tests")
      .select(`
        id, test_name, status, due_date, time_limit_minutes,
        modules!inner(module_name, section, module_number)
      `)
      .in("id", testIds)
      .order("due_date", { ascending: true }),
    db.from("submissions")
      .select("test_id, status, score")
      .in("test_id", testIds),
  ]);

  const assignMap: Record<string, { student_ids: string[] }> = {};
  for (const a of assignments) {
    assignMap[a.test_id] = { student_ids: a.student_ids ?? [] };
  }

  const subMap: Record<string, { done: number; scores: number[] }> = {};
  for (const s of subData ?? []) {
    if (!subMap[s.test_id]) subMap[s.test_id] = { done: 0, scores: [] };
    if (s.status === "Submitted" || s.status === "Late") {
      subMap[s.test_id].done++;
      if (s.score != null) subMap[s.test_id].scores.push(Number(s.score));
    }
  }

  return (tests ?? []).map((t) => {
    const assign = assignMap[t.id] ?? { student_ids: [] };
    const subs = subMap[t.id] ?? { done: 0, scores: [] };
    const avgScore = subs.scores.length > 0
      ? subs.scores.reduce((a, b) => a + b, 0) / subs.scores.length
      : null;
    return {
      ...t,
      totalStudents: assign.student_ids.length,
      submittedCount: subs.done,
      avgScore,
    };
  });
}

const statusStyles: Record<string, string> = {
  Draft: "bg-white/10 text-soft-gray/60",
  Published: "bg-lime-green/15 text-lime-green",
  Closed: "bg-rose/15 text-rose",
};

export default async function TeacherTestsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const tests = await getTeacherTests(user.userId);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-white">My Tests</h1>

      <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
        {tests.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <ClipboardList size={40} className="text-soft-gray/20 mx-auto" />
            <p className="text-soft-gray/40 text-sm">No tests assigned to you yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-soft-gray/50">
                  <th className="text-left px-5 py-3 font-medium">Test Name</th>
                  <th className="text-left px-5 py-3 font-medium">Section</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Students</th>
                  <th className="text-left px-5 py-3 font-medium">Submitted</th>
                  <th className="text-left px-5 py-3 font-medium">Avg Score</th>
                  <th className="text-left px-5 py-3 font-medium">Due</th>
                  <th className="text-left px-5 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((test) => {
                  const mod = test.modules as unknown as { module_name: string; section: string; module_number: number | null };
                  return (
                    <tr key={test.id} className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
                      <td className="px-5 py-3">
                        <Link href={`/teacher/tests/${test.id}`} className="text-white font-medium hover:text-electric-blue transition-colors">
                          {test.test_name}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {mod.section}{mod.module_number ? ` M${mod.module_number}` : ""}
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx("px-2 py-1 rounded-full text-xs font-medium", statusStyles[test.status] ?? "bg-white/10 text-soft-gray/60")}>
                          {test.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">{test.totalStudents}</td>
                      <td className="px-5 py-3 text-soft-gray/70">{test.submittedCount}</td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {test.avgScore != null ? `${test.avgScore.toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-5 py-3 text-soft-gray/50 text-xs">
                        {test.due_date ? new Date(test.due_date).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-5 py-3">
                        <Link href={`/teacher/tests/${test.id}`} className="text-xs text-electric-blue hover:underline">
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
