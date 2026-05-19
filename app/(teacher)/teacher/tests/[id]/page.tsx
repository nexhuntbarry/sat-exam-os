import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { formatDate, formatDateTime } from "@/lib/datetime";
import ReviewModeToggle from "@/components/tests/ReviewModeToggle";

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
      show_answers_after_submission, allow_retake, review_unlocked,
      modules!module_id(module_name, section, module_number)
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
  "In Progress": "bg-warm-coral/15 text-warm-coral",
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
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
  const mod = test.modules as unknown as
    | { module_name: string; section: string; module_number: number | null }
    | null;
  const submitted = submissions.filter((s) => s.status === "Submitted" || s.status === "Late");
  const avgScore = submitted.length > 0
    ? submitted.reduce((sum, s) => sum + (Number(s.percentage) || 0), 0) / submitted.length
    : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <span className="text-charcoal">{test.test_name}</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-charcoal">{test.test_name}</h1>
        <p className="text-soft-mute text-sm mt-1">
          {mod
            ? <>{mod.module_name} · {mod.section}{mod.module_number ? ` M${mod.module_number}` : ""}</>
            : "Adaptive · Module 1 + Module 2 (easy/hard)"}
        </p>
      </div>

      <ReviewModeToggle
        testId={test.id}
        initialUnlocked={Boolean((test as { review_unlocked?: boolean }).review_unlocked)}
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Submitted</div>
          <div className="text-2xl font-bold text-charcoal">{submitted.length} / {submissions.length}</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Avg Score</div>
          <div className="text-2xl font-bold text-warm-amber">
            {avgScore != null ? `${avgScore.toFixed(1)}%` : "—"}
          </div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Due Date</div>
          <div className="text-charcoal font-semibold text-sm">
            {test.due_date ? formatDateTime(test.due_date) : "—"}
          </div>
        </div>
      </div>

      {/* Action links */}
      <div className="flex flex-wrap gap-3">
        <Link
          href={`/teacher/tests/${id}/results`}
          className="px-4 py-2 rounded-xl bg-warm-coral/10 border border-warm-coral/20 text-warm-coral text-sm font-medium hover:bg-warm-coral/20 transition-colors"
        >
          Full Results Dashboard
        </Link>
        <Link
          href={`/teacher/tests/${id}/analytics`}
          className="px-4 py-2 rounded-xl bg-light-bg border border-divider text-mid-gray text-sm font-medium hover:text-charcoal hover:bg-light-bg transition-colors"
        >
          Question Analytics
        </Link>
      </div>

      {/* Submissions list */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-divider">
          <h2 className="text-charcoal font-semibold">Student Submissions</h2>
        </div>
        {submissions.length === 0 ? (
          <div className="py-12 text-center text-soft-mute text-sm">No submissions yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
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
                    <tr key={sub.id} className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors">
                      <td className="px-5 py-3">
                        <div className="text-charcoal font-medium">{u.display_name}</div>
                        <div className="text-soft-mute text-xs">{u.email}</div>
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx("px-2 py-1 rounded-full text-xs font-medium", statusStyles[sub.status] ?? "bg-light-bg text-mid-gray")}>
                          {sub.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {sub.percentage != null ? `${Number(sub.percentage).toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {sub.correct_count != null ? `${sub.correct_count}/${sub.total_questions}` : "—"}
                      </td>
                      <td className="px-5 py-3 text-mid-gray">{formatDuration(sub.time_spent_seconds)}</td>
                      <td className="px-5 py-3 text-soft-mute text-xs">
                        {sub.submitted_at ? formatDateTime(sub.submitted_at) : "—"}
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
