import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { ClipboardList, Users, BarChart2, AlertTriangle } from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate, formatDateTime } from "@/lib/datetime";

async function getTeacherDashboardData(userId: string) {
  const db = getServiceClient();

  // Get assigned tests
  const { data: assignments } = await db
    .from("test_assignments")
    .select("test_id, student_ids")
    .contains("teacher_ids", JSON.stringify([userId]));

  if (!assignments || assignments.length === 0) {
    return { tests: [], recentSubmissions: [], attentionStudents: [], stats: { assignedTests: 0, studentsCount: 0, weekSubmissions: 0 } };
  }

  const testIds = assignments.map((a) => a.test_id);
  const allStudentIds = [...new Set(assignments.flatMap((a) => (a.student_ids as string[]) ?? []))];

  const { data: tests } = await db
    .from("tests")
    .select("id, test_name, status, due_date, modules!module_id(module_name, section)")
    .in("id", testIds)
    .eq("status", "Published")
    .order("due_date", { ascending: true })
    .limit(10);

  // Get submissions for this week
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: weekSubs } = await db
    .from("submissions")
    .select("id, student_id, test_id, status, percentage, submitted_at, users!inner(display_name, email)")
    .in("test_id", testIds)
    .gte("submitted_at", oneWeekAgo)
    .in("status", ["Submitted", "Late"])
    .order("submitted_at", { ascending: false })
    .limit(10);

  // Get submission counts per test
  const { data: allSubs } = await db
    .from("submissions")
    .select("test_id, status, percentage, student_id")
    .in("test_id", testIds);

  const subMap: Record<string, { submitted: number; total: number; scores: number[] }> = {};
  for (const s of allSubs ?? []) {
    if (!subMap[s.test_id]) subMap[s.test_id] = { submitted: 0, total: 0, scores: [] };
    subMap[s.test_id].total++;
    if (s.status === "Submitted" || s.status === "Late") {
      subMap[s.test_id].submitted++;
      if (s.percentage != null) subMap[s.test_id].scores.push(Number(s.percentage));
    }
  }

  // Students needing attention: < 60% on recent submissions
  const studentScores: Record<string, number[]> = {};
  for (const s of allSubs ?? []) {
    if ((s.status === "Submitted" || s.status === "Late") && s.percentage != null) {
      if (!studentScores[s.student_id]) studentScores[s.student_id] = [];
      studentScores[s.student_id].push(Number(s.percentage));
    }
  }

  const lowStudentIds = Object.entries(studentScores)
    .filter(([, scores]) => {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      return avg < 60;
    })
    .map(([id]) => id)
    .slice(0, 10);

  const { data: attentionUsers } = lowStudentIds.length > 0
    ? await db.from("users").select("id, display_name, email").in("id", lowStudentIds)
    : { data: [] };

  const attentionWithScores = (attentionUsers ?? []).map((u) => ({
    ...u,
    avgScore: studentScores[u.id]
      ? studentScores[u.id].reduce((a, b) => a + b, 0) / studentScores[u.id].length
      : null,
  }));

  const enrichedTests = (tests ?? []).map((t) => {
    const assign = assignments.find((a) => a.test_id === t.id);
    const studentCount = (assign?.student_ids as string[] ?? []).length;
    const subs = subMap[t.id] ?? { submitted: 0, total: 0, scores: [] };
    return { ...t, studentCount, submittedCount: subs.submitted };
  });

  return {
    tests: enrichedTests,
    recentSubmissions: (weekSubs ?? []).map((s) => ({
      ...s,
      student: s.users as unknown as { display_name: string; email: string },
    })),
    attentionStudents: attentionWithScores,
    stats: {
      assignedTests: testIds.length,
      studentsCount: allStudentIds.length,
      weekSubmissions: weekSubs?.length ?? 0,
    },
  };
}

const statusCls: Record<string, string> = {
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  "In Progress": "bg-warm-coral/15 text-warm-coral",
};

export default async function TeacherDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { tests, recentSubmissions, attentionStudents, stats } = await getTeacherDashboardData(user.userId);

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <PageIntro tKey="teacher.dashboard" />
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-charcoal">
          Welcome, {user.displayName ?? "Teacher"}
        </h1>
        <p className="text-soft-mute text-sm mt-1">Here is your teaching overview.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="flex items-center gap-4 p-5 rounded-2xl border bg-warm-coral/10 border-warm-coral/20">
          <div className="p-3 rounded-xl bg-light-bg">
            <ClipboardList size={20} className="text-warm-coral" />
          </div>
          <div>
            <div className="text-2xl font-bold text-warm-coral">{stats.assignedTests}</div>
            <div className="text-mid-gray text-xs mt-0.5">Assigned Tests</div>
          </div>
        </div>
        <div className="flex items-center gap-4 p-5 rounded-2xl border bg-warm-amber/10 border-warm-amber/20">
          <div className="p-3 rounded-xl bg-light-bg">
            <Users size={20} className="text-warm-amber" />
          </div>
          <div>
            <div className="text-2xl font-bold text-warm-amber">{stats.studentsCount}</div>
            <div className="text-mid-gray text-xs mt-0.5">Students</div>
          </div>
        </div>
        <div className="flex items-center gap-4 p-5 rounded-2xl border bg-status-success/10 border-status-success/20">
          <div className="p-3 rounded-xl bg-light-bg">
            <BarChart2 size={20} className="text-status-success" />
          </div>
          <div>
            <div className="text-2xl font-bold text-status-success">{stats.weekSubmissions}</div>
            <div className="text-mid-gray text-xs mt-0.5">Submissions This Week</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Published tests */}
        <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-divider flex items-center justify-between">
            <h2 className="text-charcoal font-semibold">Active Tests</h2>
            <Link href="/teacher/tests" className="text-warm-coral text-xs hover:underline">View all</Link>
          </div>
          {tests.length === 0 ? (
            <div className="py-10 px-6 text-center text-sm space-y-2">
              <p className="text-soft-mute">No active tests yet.</p>
              <p className="text-mid-gray">
                Build a quick practice test in{" "}
                <Link href="/teacher/teaching-mode" className="text-warm-coral hover:underline">
                  Teaching Mode
                </Link>
                , or ask your admin to assign one. New here?{" "}
                <Link href="/teacher/help" className="text-warm-coral hover:underline">
                  Read the Quick Start
                </Link>
                .
              </p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {tests.map((t) => {
                const mod = t.modules as unknown as { module_name: string; section: string } | null;
                return (
                  <div key={t.id} className="px-5 py-3 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/teacher/tests/${t.id}/results`}
                        className="text-charcoal text-sm font-medium hover:text-warm-coral transition-colors truncate block"
                      >
                        {t.test_name}
                      </Link>
                      <div className="text-soft-mute text-xs">{mod?.section ?? "Adaptive"}</div>
                    </div>
                    <div className="text-right flex-shrink-0 text-xs text-soft-mute">
                      <div>{t.submittedCount}/{t.studentCount} submitted</div>
                      {t.due_date && (
                        <div>Due {formatDate(t.due_date)}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent submissions */}
        <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-divider">
            <h2 className="text-charcoal font-semibold">Recent Submissions</h2>
          </div>
          {recentSubmissions.length === 0 ? (
            <div className="py-10 px-6 text-center text-sm space-y-2">
              <p className="text-soft-mute">No submissions this week.</p>
              <p className="text-mid-gray text-xs">
                Submissions appear here as students finish their tests.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {recentSubmissions.map((s) => (
                <div key={s.id} className="px-5 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-charcoal text-sm font-medium">{s.student.display_name}</div>
                    <div className="text-soft-mute text-xs">
                      {s.submitted_at ? formatDateTime(s.submitted_at) : ""}
                    </div>
                  </div>
                  <span className={clsx(
                    "px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0",
                    statusCls[s.status] ?? "bg-light-bg text-soft-mute"
                  )}>
                    {s.percentage != null ? `${Number(s.percentage).toFixed(0)}%` : s.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Students needing attention */}
      {attentionStudents.length > 0 && (
        <div className="bg-status-warning/5 border border-status-warning/15 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-status-warning/20 flex items-center gap-2">
            <AlertTriangle size={16} className="text-status-warning" />
            <h2 className="text-status-warning font-semibold">Students Needing Attention</h2>
            <span className="text-soft-mute text-xs">(avg &lt; 60%)</span>
          </div>
          <div className="divide-y divide-white/5">
            {attentionStudents.map((s) => (
              <div key={s.id} className="px-5 py-3 flex items-center justify-between gap-4">
                <div>
                  <div className="text-charcoal text-sm font-medium">{s.display_name}</div>
                  <div className="text-soft-mute text-xs">{s.email}</div>
                </div>
                <div className="text-status-error font-bold text-sm">
                  {s.avgScore != null ? `${s.avgScore.toFixed(1)}% avg` : "—"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
