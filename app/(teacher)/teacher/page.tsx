import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { ClipboardList, Users, BarChart2, AlertTriangle } from "lucide-react";

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
    .select("id, test_name, status, due_date, modules!inner(module_name, section)")
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
  Submitted: "bg-lime-green/15 text-lime-green",
  Late: "bg-amber/15 text-amber",
  "In Progress": "bg-electric-blue/15 text-electric-blue",
};

export default async function TeacherDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { tests, recentSubmissions, attentionStudents, stats } = await getTeacherDashboardData(user.userId);

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">
          Welcome, {user.displayName ?? "Teacher"}
        </h1>
        <p className="text-soft-gray/50 text-sm mt-1">Here is your teaching overview.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="flex items-center gap-4 p-5 rounded-2xl border bg-electric-blue/10 border-electric-blue/20">
          <div className="p-3 rounded-xl bg-white/5">
            <ClipboardList size={20} className="text-electric-blue" />
          </div>
          <div>
            <div className="text-2xl font-bold text-electric-blue">{stats.assignedTests}</div>
            <div className="text-soft-gray/60 text-xs mt-0.5">Assigned Tests</div>
          </div>
        </div>
        <div className="flex items-center gap-4 p-5 rounded-2xl border bg-lime-green/10 border-lime-green/20">
          <div className="p-3 rounded-xl bg-white/5">
            <Users size={20} className="text-lime-green" />
          </div>
          <div>
            <div className="text-2xl font-bold text-lime-green">{stats.studentsCount}</div>
            <div className="text-soft-gray/60 text-xs mt-0.5">Students</div>
          </div>
        </div>
        <div className="flex items-center gap-4 p-5 rounded-2xl border bg-emerald/10 border-emerald/20">
          <div className="p-3 rounded-xl bg-white/5">
            <BarChart2 size={20} className="text-emerald" />
          </div>
          <div>
            <div className="text-2xl font-bold text-emerald">{stats.weekSubmissions}</div>
            <div className="text-soft-gray/60 text-xs mt-0.5">Submissions This Week</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Published tests */}
        <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/8 flex items-center justify-between">
            <h2 className="text-white font-semibold">Active Tests</h2>
            <Link href="/teacher/tests" className="text-electric-blue text-xs hover:underline">View all</Link>
          </div>
          {tests.length === 0 ? (
            <div className="py-10 text-center text-soft-gray/40 text-sm">No active tests.</div>
          ) : (
            <div className="divide-y divide-white/5">
              {tests.map((t) => {
                const mod = t.modules as unknown as { module_name: string; section: string };
                return (
                  <div key={t.id} className="px-5 py-3 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/teacher/tests/${t.id}/results`}
                        className="text-white text-sm font-medium hover:text-electric-blue transition-colors truncate block"
                      >
                        {t.test_name}
                      </Link>
                      <div className="text-soft-gray/40 text-xs">{mod.section}</div>
                    </div>
                    <div className="text-right flex-shrink-0 text-xs text-soft-gray/50">
                      <div>{t.submittedCount}/{t.studentCount} submitted</div>
                      {t.due_date && (
                        <div>Due {new Date(t.due_date).toLocaleDateString()}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent submissions */}
        <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/8">
            <h2 className="text-white font-semibold">Recent Submissions</h2>
          </div>
          {recentSubmissions.length === 0 ? (
            <div className="py-10 text-center text-soft-gray/40 text-sm">No submissions this week.</div>
          ) : (
            <div className="divide-y divide-white/5">
              {recentSubmissions.map((s) => (
                <div key={s.id} className="px-5 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-sm font-medium">{s.student.display_name}</div>
                    <div className="text-soft-gray/40 text-xs">
                      {s.submitted_at ? new Date(s.submitted_at).toLocaleString() : ""}
                    </div>
                  </div>
                  <span className={clsx(
                    "px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0",
                    statusCls[s.status] ?? "bg-white/10 text-soft-gray/50"
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
        <div className="bg-amber/5 border border-amber/15 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-amber/10 flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber" />
            <h2 className="text-amber font-semibold">Students Needing Attention</h2>
            <span className="text-soft-gray/40 text-xs">(avg &lt; 60%)</span>
          </div>
          <div className="divide-y divide-white/5">
            {attentionStudents.map((s) => (
              <div key={s.id} className="px-5 py-3 flex items-center justify-between gap-4">
                <div>
                  <div className="text-white text-sm font-medium">{s.display_name}</div>
                  <div className="text-soft-gray/40 text-xs">{s.email}</div>
                </div>
                <div className="text-rose font-bold text-sm">
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
