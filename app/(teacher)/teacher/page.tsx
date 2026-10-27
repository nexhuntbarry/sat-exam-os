import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { getQaUserIds, scopeIds } from "@/lib/qa";
import { getAssignedStudentIds, getTeacherTestScope, seesAllStudents } from "@/lib/teacher-access";
import { redirect } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { sectionTitleClass } from "@/lib/section-color";
import { ClipboardList, Users, BarChart2, AlertTriangle } from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate, formatDateTime } from "@/lib/datetime";

async function getTeacherDashboardData(user: { userId: string; role: string | null; isQa: boolean }) {
  const db = getServiceClient();

  // Same visible-test set as My Tests: direct ∪ class-assigned/taken,
  // subject-scoped, QA-isolated.
  const scope = await getTeacherTestScope(db, user);
  if (scope.testIds.size === 0) {
    return { tests: [], recentSubmissions: [], attentionStudents: [], stats: { assignedTests: 0, studentsCount: 0, weekSubmissions: 0 } };
  }
  const testIds = Array.from(scope.testIds);
  const qaUsers = await getQaUserIds();

  const [{ data: tests, error: testsError }, { data: assignments, error: assignError }, { data: allSubs, error: subError }] = await Promise.all([
    db
      .from("tests")
      .select("id, test_name, status, due_date, modules!module_id(module_name, section)")
      .in("id", testIds)
      .eq("status", "Published")
      .order("due_date", { ascending: true })
      .limit(10),
    db.from("test_assignments").select("test_id, student_ids, class_group_ids").in("test_id", testIds),
    scopeIds(db
      .from("submissions")
      .select("id, test_id, student_id, status, correct_count, total_questions, percentage, submitted_at, session_id, users!inner(display_name, email)")
      .in("test_id", testIds), "student_id", qaUsers, user.isQa),
  ]);
  if (testsError) throw new Error(`tests lookup failed: ${testsError.message}`);
  if (assignError) throw new Error(`test_assignments lookup failed: ${assignError.message}`);
  if (subError) throw new Error(`submissions lookup failed: ${subError.message}`);

  // Assigned roster per test (student_ids ∪ class members), limited to my
  // students unless I see the whole test.
  const rosterByTest = new Map<string, Set<string>>();
  await Promise.all((assignments ?? []).map(async (a) => {
    const allowlist = seesAllStudents(scope, a.test_id as string) ? null : scope.myStudentIds;
    rosterByTest.set(a.test_id as string, await getAssignedStudentIds(db, a, user.isQa, allowlist));
  }));
  const allStudentIds = new Set<string>();
  for (const roster of rosterByTest.values()) for (const sid of roster) allStudentIds.add(sid);

  // Group module rows into attempts (two-module attempts share a session_id)
  // so counts and averages don't double-count.
  type SubRow = {
    id: string;
    test_id: string;
    student_id: string;
    status: string;
    correct_count: number | null;
    total_questions: number | null;
    percentage: number | string | null;
    submitted_at: string | null;
    session_id: string | null;
    users: unknown;
  };
  const attemptRows = new Map<string, SubRow[]>();
  for (const s of (allSubs ?? []) as SubRow[]) {
    if (!seesAllStudents(scope, s.test_id) && !scope.myStudentIds.has(s.student_id)) continue;
    const key = s.session_id ?? s.id;
    attemptRows.set(key, [...(attemptRows.get(key) ?? []), s]);
  }
  const attempts = Array.from(attemptRows.entries()).map(([key, rows]) => {
    const correct = rows.reduce((n, r) => n + (r.correct_count ?? 0), 0);
    const total = rows.reduce((n, r) => n + (r.total_questions ?? 0), 0);
    const done = rows.every((r) => r.status === "Submitted" || r.status === "Late");
    const percentage = total > 0
      ? (correct / total) * 100
      : rows[0].percentage != null ? Number(rows[0].percentage) : null;
    const submittedAt = rows.map((r) => r.submitted_at).filter((d): d is string => !!d).sort().pop() ?? null;
    return {
      id: key,
      testId: rows[0].test_id,
      studentId: rows[0].student_id,
      status: done ? (rows.some((r) => r.status === "Late") ? "Late" : "Submitted") : "In Progress",
      done,
      percentage,
      submitted_at: submittedAt,
      student: rows[0].users as { display_name: string; email: string },
    };
  });

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekAttempts = attempts
    .filter((a) => a.done && a.submitted_at && a.submitted_at >= oneWeekAgo)
    .sort((a, b) => (b.submitted_at ?? "").localeCompare(a.submitted_at ?? ""));

  const submittedByTest: Record<string, number> = {};
  const studentScores: Record<string, number[]> = {};
  for (const a of attempts) {
    if (!a.done) continue;
    submittedByTest[a.testId] = (submittedByTest[a.testId] ?? 0) + 1;
    if (a.percentage != null) (studentScores[a.studentId] ??= []).push(a.percentage);
  }

  // Students needing attention: < 60% average across attempts
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

  const enrichedTests = (tests ?? []).map((t) => ({
    ...t,
    studentCount: rosterByTest.get(t.id)?.size ?? 0,
    submittedCount: submittedByTest[t.id] ?? 0,
  }));

  return {
    tests: enrichedTests,
    recentSubmissions: weekAttempts.slice(0, 10),
    attentionStudents: attentionWithScores,
    stats: {
      assignedTests: testIds.length,
      studentsCount: allStudentIds.size,
      weekSubmissions: weekAttempts.length,
    },
  };
}

const statusCls: Record<string, string> = {
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  "In Progress": "bg-warm-coral/15 text-warm-coral-text",
};

export default async function TeacherDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { tests, recentSubmissions, attentionStudents, stats } = await getTeacherDashboardData(user);

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
            <ClipboardList size={20} className="text-warm-coral-text" />
          </div>
          <div>
            <div className="text-2xl font-bold text-warm-coral-text">{stats.assignedTests}</div>
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
            <Link href="/teacher/tests" className="text-warm-coral-text text-xs hover:underline">View all</Link>
          </div>
          {tests.length === 0 ? (
            <div className="py-10 px-6 text-center text-sm space-y-2">
              <p className="text-soft-mute">No active tests yet.</p>
              <p className="text-mid-gray">
                Build a quick practice test in{" "}
                <Link href="/teacher/teaching-mode" className="text-warm-coral-text hover:underline">
                  Teaching Mode
                </Link>
                , or ask your admin to assign one. New here?{" "}
                <Link href="/teacher/help" className="text-warm-coral-text hover:underline">
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
                        className={clsx("text-sm font-medium hover:text-warm-coral-text transition-colors truncate block", sectionTitleClass(mod?.section))}
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
