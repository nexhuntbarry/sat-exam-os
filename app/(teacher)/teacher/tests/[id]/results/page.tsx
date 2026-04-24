import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Download } from "lucide-react";
import { StatCard } from "@/components/analytics/StatCard";
import { ScoreDistributionChart } from "@/components/analytics/ScoreDistributionChart";
import { StudentResultsTable } from "@/components/analytics/StudentResultsTable";
import type { StudentResultRow } from "@/components/analytics/StudentResultsTable";

async function getResultsData(testId: string, userId: string, role: string) {
  const db = getServiceClient();

  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids, student_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) return null;
  const teacherIds: string[] = assignment.teacher_ids ?? [];
  if (role !== "admin" && !teacherIds.includes(userId)) return null;

  const { data: test } = await db
    .from("tests")
    .select("id, test_name, time_limit_minutes, due_date, status, modules!inner(module_name, section, module_number)")
    .eq("id", testId)
    .single();

  if (!test) return null;

  const studentIds: string[] = assignment.student_ids ?? [];

  const { data: submissions } = await db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, submitted_at, time_spent_seconds,
      users!inner(display_name, email),
      student_profiles(grade, class_group)
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: false });

  const subs = submissions ?? [];
  const submitted = subs.filter((s) => s.status === "Submitted" || s.status === "Late");

  const scores = submitted.map((s) => Number(s.percentage ?? 0));
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  const highestSub = submitted.length > 0
    ? submitted.reduce((a, b) => Number(a.percentage) > Number(b.percentage) ? a : b)
    : null;
  const lowestSub = submitted.length > 0
    ? submitted.reduce((a, b) => Number(a.percentage) < Number(b.percentage) ? a : b)
    : null;

  const avgTime = submitted.length > 0
    ? submitted.reduce((sum, s) => sum + (s.time_spent_seconds ?? 0), 0) / submitted.length
    : null;

  const buckets = Array.from({ length: 10 }, (_, i) => ({
    label: `${i * 10}–${(i + 1) * 10}%`,
    count: 0,
  }));
  for (const s of submitted) {
    const pct = Number(s.percentage ?? 0);
    const idx = Math.min(Math.floor(pct / 10), 9);
    buckets[idx].count++;
  }

  const studentRows: StudentResultRow[] = subs.map((s) => {
    const u = s.users as unknown as { display_name: string; email: string };
    const sp = s.student_profiles as unknown as { grade?: string; class_group?: string } | null;
    return {
      submissionId: s.id,
      studentName: u.display_name,
      email: u.email,
      grade: sp?.grade ?? null,
      classGroup: sp?.class_group ?? null,
      status: s.status,
      score: s.score != null ? Number(s.score) : null,
      percentage: s.percentage != null ? Number(s.percentage) : null,
      correctCount: s.correct_count ?? 0,
      totalQuestions: s.total_questions ?? 0,
      timeSpentSeconds: s.time_spent_seconds ?? null,
      submittedAt: s.submitted_at ?? null,
    };
  });

  const getName = (s: typeof subs[number]) => (s.users as unknown as { display_name: string }).display_name;

  return {
    test,
    stats: {
      totalAssigned: studentIds.length,
      submittedCount: submitted.length,
      notStartedCount: Math.max(0, studentIds.length - subs.length),
      inProgressCount: subs.filter((s) => s.status === "In Progress").length,
      lateCount: subs.filter((s) => s.status === "Late").length,
      avgScore,
      highestScore: highestSub ? { pct: Number(highestSub.percentage), name: getName(highestSub) } : null,
      lowestScore: lowestSub ? { pct: Number(lowestSub.percentage), name: getName(lowestSub) } : null,
      avgTimeSeconds: avgTime,
    },
    scoreDistribution: buckets,
    students: studentRows,
  };
}

function fmtTime(s: number | null) {
  if (!s) return "—";
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export default async function TestResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const data = await getResultsData(id, user.userId, user.role ?? "");
  if (!data) notFound();

  const { test, stats, scoreDistribution, students } = data;
  const mod = test.modules as unknown as { module_name: string; section: string; module_number: number | null };

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-soft-gray/50 text-sm flex-wrap">
        <Link href="/teacher/tests" className="hover:text-soft-gray transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${id}`} className="hover:text-soft-gray transition-colors">{test.test_name}</Link>
        <span>/</span>
        <span className="text-white">Results</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">{test.test_name} — Results</h1>
          <p className="text-soft-gray/50 text-sm mt-1">
            {mod.module_name} · {mod.section}{mod.module_number ? ` M${mod.module_number}` : ""}
            {test.time_limit_minutes && ` · ${test.time_limit_minutes} min`}
            {test.due_date && ` · Due ${new Date(test.due_date).toLocaleDateString()}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/teacher/tests/${id}/analytics`}
            className="px-4 py-2 rounded-xl bg-electric-blue/10 border border-electric-blue/20 text-electric-blue text-sm font-medium hover:bg-electric-blue/20 transition-colors"
          >
            Question Analytics
          </Link>
          <a
            href={`/api/teacher/tests/${id}/export`}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-lime-green/10 border border-lime-green/20 text-lime-green text-sm font-medium hover:bg-lime-green/20 transition-colors"
          >
            <Download size={14} />
            Export CSV
          </a>
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total Assigned" value={stats.totalAssigned} color="default" />
        <StatCard
          label="Submitted"
          value={`${stats.submittedCount}`}
          sub={stats.totalAssigned > 0 ? `${((stats.submittedCount / stats.totalAssigned) * 100).toFixed(0)}%` : undefined}
          color="lime"
        />
        <StatCard label="Not Started" value={stats.notStartedCount} color="default" />
        <StatCard label="In Progress" value={stats.inProgressCount} color="blue" />
        <StatCard label="Late Submissions" value={stats.lateCount} color="amber" />
        <StatCard
          label="Avg Score"
          value={stats.avgScore != null ? `${stats.avgScore.toFixed(1)}%` : "—"}
          color="emerald"
        />
        <StatCard
          label="Highest Score"
          value={stats.highestScore != null ? `${stats.highestScore.pct.toFixed(1)}%` : "—"}
          sub={stats.highestScore?.name}
          color="lime"
        />
        <StatCard
          label="Lowest Score"
          value={stats.lowestScore != null ? `${stats.lowestScore.pct.toFixed(1)}%` : "—"}
          sub={stats.lowestScore?.name}
          color="rose"
        />
        <StatCard
          label="Avg Time Spent"
          value={fmtTime(stats.avgTimeSeconds)}
          color="default"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
          <h2 className="text-white font-semibold mb-4">Score Distribution</h2>
          <ScoreDistributionChart data={scoreDistribution} />
        </div>
        <div className="bg-white/3 border border-white/8 rounded-2xl p-5">
          <h2 className="text-white font-semibold mb-2">Status Breakdown</h2>
          <div className="space-y-3 mt-4">
            {[
              { label: "Submitted", value: stats.submittedCount, color: "bg-lime-green" },
              { label: "Late", value: stats.lateCount, color: "bg-amber" },
              { label: "In Progress", value: stats.inProgressCount, color: "bg-electric-blue" },
              { label: "Not Started", value: stats.notStartedCount, color: "bg-white/20" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3 text-sm">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${item.color}`} />
                <span className="text-soft-gray/60 flex-1">{item.label}</span>
                <span className="text-white font-medium">{item.value}</span>
                <div className="w-24 bg-white/5 rounded-full h-1.5 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${item.color}`}
                    style={{ width: `${stats.totalAssigned > 0 ? (item.value / stats.totalAssigned) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Student results table */}
      <div>
        <h2 className="text-white font-semibold text-lg mb-4">Student Results</h2>
        <StudentResultsTable rows={students} testId={id} />
      </div>
    </div>
  );
}
