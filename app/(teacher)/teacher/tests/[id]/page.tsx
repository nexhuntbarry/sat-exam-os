import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";

async function getTeacherTest(testId: string, teacherId: string) {
  const db = getServiceClient();

  // Verify teacher is assigned
  const { data: assignment } = await db
    .from("test_assignments")
    .select("test_id, teacher_ids, student_ids, class_group_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) return null;
  const teacherIds: string[] = assignment.teacher_ids ?? [];
  if (!teacherIds.includes(teacherId)) return null;

  const { data: test } = await db
    .from("tests")
    .select(`
      id, test_name, status, time_limit_minutes, due_date, open_date,
      show_answers_after_submission, allow_retake,
      modules!inner(module_name, section, module_number)
    `)
    .eq("id", testId)
    .single();

  if (!test) return null;

  const studentIds: string[] = assignment.student_ids ?? [];

  const { data: submissions } = await db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, submitted_at, time_spent_seconds,
      users!inner(display_name, email)
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: false });

  return {
    test,
    studentIds,
    submissions: submissions ?? [],
  };
}

const statusStyles: Record<string, string> = {
  "In Progress": "bg-electric-blue/15 text-electric-blue",
  Submitted: "bg-lime-green/15 text-lime-green",
  Late: "bg-amber/15 text-amber",
};

function formatDuration(seconds: number | null) {
  if (!seconds) return "—";
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default async function TeacherTestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const data = await getTeacherTest(id, user.userId);
  if (!data) notFound();

  const { test, submissions } = data;
  const mod = test.modules as unknown as { module_name: string; section: string; module_number: number | null };
  const submitted = submissions.filter((s) => s.status === "Submitted" || s.status === "Late");
  const avgScore = submitted.length > 0
    ? submitted.reduce((sum, s) => sum + (Number(s.percentage) || 0), 0) / submitted.length
    : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-gray/50 text-sm">
        <Link href="/teacher/tests" className="hover:text-soft-gray transition-colors">Tests</Link>
        <span>/</span>
        <span className="text-white">{test.test_name}</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-white">{test.test_name}</h1>
        <p className="text-soft-gray/50 text-sm mt-1">
          {mod.module_name} · {mod.section}{mod.module_number ? ` M${mod.module_number}` : ""}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white/3 border border-white/8 rounded-xl p-4">
          <div className="text-soft-gray/50 text-xs mb-1">Submitted</div>
          <div className="text-2xl font-bold text-white">{submitted.length} / {submissions.length}</div>
        </div>
        <div className="bg-white/3 border border-white/8 rounded-xl p-4">
          <div className="text-soft-gray/50 text-xs mb-1">Avg Score</div>
          <div className="text-2xl font-bold text-lime-green">
            {avgScore != null ? `${avgScore.toFixed(1)}%` : "—"}
          </div>
        </div>
        <div className="bg-white/3 border border-white/8 rounded-xl p-4">
          <div className="text-soft-gray/50 text-xs mb-1">Due Date</div>
          <div className="text-white font-semibold text-sm">
            {test.due_date ? new Date(test.due_date).toLocaleString() : "—"}
          </div>
        </div>
      </div>

      {/* Submissions list */}
      <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/8">
          <h2 className="text-white font-semibold">Student Submissions</h2>
        </div>
        {submissions.length === 0 ? (
          <div className="py-12 text-center text-soft-gray/40 text-sm">No submissions yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-soft-gray/50">
                  <th className="text-left px-5 py-3 font-medium">Student</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Score</th>
                  <th className="text-left px-5 py-3 font-medium">Correct</th>
                  <th className="text-left px-5 py-3 font-medium">Time</th>
                  <th className="text-left px-5 py-3 font-medium">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((sub) => {
                  const u = sub.users as unknown as { display_name: string; email: string };
                  return (
                    <tr key={sub.id} className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
                      <td className="px-5 py-3">
                        <div className="text-white font-medium">{u.display_name}</div>
                        <div className="text-soft-gray/40 text-xs">{u.email}</div>
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx("px-2 py-1 rounded-full text-xs font-medium", statusStyles[sub.status] ?? "bg-white/10 text-soft-gray/60")}>
                          {sub.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {sub.percentage != null ? `${Number(sub.percentage).toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {sub.correct_count != null ? `${sub.correct_count}/${sub.total_questions}` : "—"}
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">{formatDuration(sub.time_spent_seconds)}</td>
                      <td className="px-5 py-3 text-soft-gray/50 text-xs">
                        {sub.submitted_at ? new Date(sub.submitted_at).toLocaleString() : "—"}
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
