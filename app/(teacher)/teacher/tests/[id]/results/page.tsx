import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { StatCard } from "@/components/analytics/StatCard";
import { ScoreDistributionChart } from "@/components/analytics/ScoreDistributionChart";
import { StudentResultsTable } from "@/components/analytics/StudentResultsTable";
import type { StudentResultRow } from "@/components/analytics/StudentResultsTable";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { scaleSectionScore } from "@/lib/scoring";

const MODULE_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
};

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
    .select("id, test_name, time_limit_minutes, due_date, status, modules!module_id(module_name, section, module_number)")
    .eq("id", testId)
    .single();

  if (!test) return null;

  const studentIds: string[] = assignment.student_ids ?? [];

  const { data: submissions } = await db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, submitted_at, time_spent_seconds, attempt_number,
      scaled_score, scaled_section, session_id, adaptive_track,
      users!inner(display_name, email, student_profiles(grade, class_group))
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: false });

  type RawSub = {
    id: string;
    student_id: string;
    status: string;
    score: number | null;
    correct_count: number | null;
    total_questions: number | null;
    percentage: number | string | null;
    submitted_at: string | null;
    time_spent_seconds: number | null;
    attempt_number: number | null;
    scaled_score: number | null;
    scaled_section: string | null;
    session_id: string | null;
    adaptive_track: string | null;
    users: {
      display_name: string;
      email: string;
      student_profiles?:
        | { grade?: string; class_group?: string }
        | { grade?: string; class_group?: string }[]
        | null;
    };
  };
  const subs = (submissions ?? []) as unknown as RawSub[];

  // Pending retake grants — student_id → grant exists. Used to surface
  // "retake unlocked" badge in the row UI.
  const { data: pendingGrants } = await db
    .from("test_retake_grants")
    .select("student_id")
    .eq("test_id", testId)
    .is("consumed_at", null);
  const pendingSet = new Set((pendingGrants ?? []).map((g) => g.student_id as string));

  // Two-module attempts span two submission rows sharing one
  // session_id; group siblings so the dashboard shows one row per
  // attempt with combined headline + per-module split, and stats
  // (avg/highest/lowest/distribution) don't double-count multi-module
  // sessions.
  const sessionGroups = new Map<string, RawSub[]>();
  for (const s of subs) {
    const key = s.session_id ?? `solo:${s.id}`;
    const list = sessionGroups.get(key) ?? [];
    list.push(s);
    sessionGroups.set(key, list);
  }

  const studentRows: StudentResultRow[] = [];
  for (const list of sessionGroups.values()) {
    const sorted = [...list].sort((a, b) => {
      const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
      return rank(a.adaptive_track) - rank(b.adaptive_track);
    });
    const head = sorted[0];
    const u = head.users;
    const spRaw = u.student_profiles ?? null;
    const sp = (Array.isArray(spRaw) ? spRaw[0] : spRaw) as
      | { grade?: string; class_group?: string }
      | null;

    if (sorted.length === 1) {
      studentRows.push({
        submissionId: head.id,
        studentId: head.student_id,
        attemptNumber: head.attempt_number ?? 1,
        studentName: u.display_name,
        email: u.email,
        grade: sp?.grade ?? null,
        classGroup: sp?.class_group ?? null,
        status: head.status,
        score: head.score != null ? Number(head.score) : null,
        percentage: head.percentage != null ? Number(head.percentage) : null,
        scaledScore: head.scaled_score ?? null,
        correctCount: head.correct_count ?? 0,
        totalQuestions: head.total_questions ?? 0,
        timeSpentSeconds: head.time_spent_seconds ?? null,
        submittedAt: head.submitted_at ?? null,
        retakePending: pendingSet.has(head.student_id),
      });
      continue;
    }
    const correct = sorted.reduce((s, r) => s + (r.correct_count ?? 0), 0);
    const total = sorted.reduce((s, r) => s + (r.total_questions ?? 0), 0);
    const time = sorted.reduce((s, r) => s + (r.time_spent_seconds ?? 0), 0);
    const pct = total > 0 ? Math.round((correct / total) * 1000) / 10 : null;
    const statuses = sorted.map((r) => r.status);
    const status = statuses.includes("In Progress")
      ? "In Progress"
      : statuses.includes("Late")
      ? "Late"
      : statuses[statuses.length - 1] ?? "Submitted";
    const lastSubmittedAt =
      sorted
        .map((r) => r.submitted_at)
        .filter((d): d is string => !!d)
        .sort()
        .pop() ?? null;
    studentRows.push({
      // Link to the Module 2 (last) submission so the result detail
      // page can stitch both modules via session_id.
      submissionId: sorted[sorted.length - 1].id,
      studentId: head.student_id,
      attemptNumber: head.attempt_number ?? 1,
      studentName: u.display_name,
      email: u.email,
      grade: sp?.grade ?? null,
      classGroup: sp?.class_group ?? null,
      status,
      score: null,
      percentage: pct,
      scaledScore: pct != null ? scaleSectionScore(pct) : null,
      correctCount: correct,
      totalQuestions: total,
      timeSpentSeconds: time,
      submittedAt: lastSubmittedAt,
      retakePending: pendingSet.has(head.student_id),
      modules: sorted.map((r) => {
        const p = r.percentage != null ? Number(r.percentage) : null;
        return {
          submissionId: r.id,
          label: MODULE_LABEL[r.adaptive_track ?? ""] ?? "Module",
          correctCount: r.correct_count ?? 0,
          totalQuestions: r.total_questions ?? 0,
          percentage: p,
          scaledScore: r.scaled_score ?? (p != null ? scaleSectionScore(p) : null),
        };
      }),
    });
  }

  // Sort newest-first to match the legacy submitted_at desc ordering.
  studentRows.sort((a, b) => {
    if (a.submittedAt && b.submittedAt) return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
  });

  const submitted = studentRows.filter((r) => r.status === "Submitted" || r.status === "Late");
  const scores = submitted.map((r) => r.percentage ?? 0);
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

  const highestSub = submitted.length > 0
    ? submitted.reduce((a, b) => ((a.percentage ?? 0) > (b.percentage ?? 0) ? a : b))
    : null;
  const lowestSub = submitted.length > 0
    ? submitted.reduce((a, b) => ((a.percentage ?? 0) < (b.percentage ?? 0) ? a : b))
    : null;

  const avgTime = submitted.length > 0
    ? submitted.reduce((sum, r) => sum + (r.timeSpentSeconds ?? 0), 0) / submitted.length
    : null;

  const buckets = Array.from({ length: 10 }, (_, i) => ({
    label: `${i * 10}–${(i + 1) * 10}%`,
    count: 0,
  }));
  for (const r of submitted) {
    const pct = r.percentage ?? 0;
    const idx = Math.min(Math.floor(pct / 10), 9);
    buckets[idx].count++;
  }

  return {
    test,
    stats: {
      totalAssigned: studentIds.length,
      submittedCount: submitted.length,
      notStartedCount: Math.max(0, studentIds.length - studentRows.length),
      inProgressCount: studentRows.filter((r) => r.status === "In Progress").length,
      lateCount: studentRows.filter((r) => r.status === "Late").length,
      avgScore,
      highestScore: highestSub ? { pct: highestSub.percentage ?? 0, name: highestSub.studentName } : null,
      lowestScore: lowestSub ? { pct: lowestSub.percentage ?? 0, name: lowestSub.studentName } : null,
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
  const mod = test.modules as unknown as
    | { module_name: string; section: string; module_number: number | null }
    | null;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-soft-mute text-sm flex-wrap">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${id}`} className="hover:text-charcoal transition-colors">{test.test_name}</Link>
        <span>/</span>
        <span className="text-charcoal">Results</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">{test.test_name} — Results</h1>
          <p className="text-soft-mute text-sm mt-1">
            {mod
              ? <>{mod.module_name} · {mod.section}{mod.module_number ? ` M${mod.module_number}` : ""}</>
              : "Adaptive · multi-module"}
            {test.time_limit_minutes && ` · ${test.time_limit_minutes} min`}
            {test.due_date && ` · Due ${formatDate(test.due_date)}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/teacher/tests/${id}/analytics`}
            className="px-4 py-2 rounded-xl bg-warm-coral/10 border border-warm-coral/20 text-warm-coral text-sm font-medium hover:bg-warm-coral/20 transition-colors"
          >
            Question Analytics
          </Link>
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
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <h2 className="text-charcoal font-semibold mb-4">Score Distribution</h2>
          <ScoreDistributionChart data={scoreDistribution} />
        </div>
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <h2 className="text-charcoal font-semibold mb-2">Status Breakdown</h2>
          <div className="space-y-3 mt-4">
            {[
              { label: "Submitted", value: stats.submittedCount, color: "bg-warm-amber" },
              { label: "Late", value: stats.lateCount, color: "bg-status-warning" },
              { label: "In Progress", value: stats.inProgressCount, color: "bg-warm-coral" },
              { label: "Not Started", value: stats.notStartedCount, color: "bg-light-bg/600" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3 text-sm">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${item.color}`} />
                <span className="text-mid-gray flex-1">{item.label}</span>
                <span className="text-charcoal font-medium">{item.value}</span>
                <div className="w-24 bg-light-bg rounded-full h-1.5 overflow-hidden">
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
        <h2 className="text-charcoal font-semibold text-lg mb-4">Student Results</h2>
        <StudentResultsTable rows={students} testId={id} />
      </div>
    </div>
  );
}
