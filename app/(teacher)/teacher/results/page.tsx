import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { StatCard } from "@/components/analytics/StatCard";
import {
  CrossTestResultsTable,
  type CrossTestResultRow,
} from "@/components/analytics/CrossTestResultsTable";
import PageIntro from "@/components/shared/PageIntro";

async function getCrossTestResults(teacherId: string, role: string) {
  const db = getServiceClient();

  // 1. Find all assignments where this teacher is listed
  let assignmentsQuery = db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids, teacher_ids");

  if (role !== "admin") {
    assignmentsQuery = assignmentsQuery.contains(
      "teacher_ids",
      JSON.stringify([teacherId])
    );
  }

  const { data: assignments } = await assignmentsQuery;

  if (!assignments || assignments.length === 0) {
    return { rows: [], testOptions: [], classOptions: [], totals: { tests: 0, submissions: 0, students: 0 } };
  }

  const testIds = assignments.map((a) => a.test_id);

  // 2. Get test metadata
  const { data: tests } = await db
    .from("tests")
    .select(`id, test_name, modules!inner(section, module_name)`)
    .in("id", testIds);

  const testMap = new Map<string, { name: string; section: string | null }>();
  for (const t of tests ?? []) {
    const m = t.modules as unknown as { section: string; module_name: string };
    testMap.set(t.id, { name: t.test_name, section: m?.section ?? null });
  }

  // 3. Get all submissions for these tests
  const { data: submissions } = await db
    .from("submissions")
    .select(
      `
      id, test_id, student_id, status, score, correct_count, total_questions,
      percentage, submitted_at, time_spent_seconds,
      users!inner(display_name, email)
    `
    )
    .in("test_id", testIds)
    .order("submitted_at", { ascending: false });

  const subs = submissions ?? [];

  // 3b. Class groups via student_profiles (separate query — no FK to submissions)
  const studentIds = Array.from(new Set(subs.map((s) => s.student_id)));
  const classMap = new Map<string, string | null>();
  if (studentIds.length > 0) {
    const { data: profiles } = await db
      .from("student_profiles")
      .select("user_id, class_group")
      .in("user_id", studentIds);
    for (const p of profiles ?? []) {
      classMap.set(p.user_id, p.class_group ?? null);
    }
  }

  const rows: CrossTestResultRow[] = subs.map((s) => {
    const u = s.users as unknown as { display_name: string; email: string };
    const meta = testMap.get(s.test_id) ?? { name: "(unknown test)", section: null };
    return {
      submissionId: s.id,
      testId: s.test_id,
      testName: meta.name,
      section: meta.section,
      studentId: s.student_id,
      studentName: u.display_name,
      email: u.email,
      classGroup: classMap.get(s.student_id) ?? null,
      status: s.status,
      score: s.score != null ? Number(s.score) : null,
      percentage: s.percentage != null ? Number(s.percentage) : null,
      correctCount: s.correct_count ?? 0,
      totalQuestions: s.total_questions ?? 0,
      timeSpentSeconds: s.time_spent_seconds ?? null,
      submittedAt: s.submitted_at ?? null,
    };
  });

  const testOptions = Array.from(testMap.entries())
    .map(([id, v]) => ({ id, name: v.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const classOptions = Array.from(
    new Set(rows.map((r) => r.classGroup).filter((c): c is string => !!c))
  ).sort();

  const uniqueStudents = new Set(rows.map((r) => r.studentId)).size;

  return {
    rows,
    testOptions,
    classOptions,
    totals: {
      tests: testIds.length,
      submissions: rows.length,
      students: uniqueStudents,
    },
  };
}

export default async function TeacherResultsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const data = await getCrossTestResults(user.userId, user.role ?? "");

  if (data.totals.tests === 0) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center space-y-6">
        <PageIntro tKey="teacher.results" />
        <div className="inline-flex p-5 rounded-2xl bg-warm-coral/10 border border-warm-coral/20">
          <ClipboardList size={36} className="text-warm-coral" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-charcoal">Student Results / 學生成績</h1>
          <p className="text-soft-mute text-sm">
            You have no tests yet. Create a test to start collecting results.
            <br />
            您尚未建立任何測驗。建立後即可在此查看跨測驗的學生成績。
          </p>
        </div>
        <Link
          href="/teacher/tests"
          className="inline-block px-5 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white text-sm font-semibold transition-colors"
        >
          Create a test / 建立測驗
        </Link>
      </div>
    );
  }

  if (data.rows.length === 0) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageIntro tKey="teacher.results" />
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Student Results / 學生成績</h1>
          <p className="text-soft-mute text-sm mt-1">
            Cross-test consolidated view across all your tests. /
            跨所有測驗的學生作答統整。
          </p>
        </div>
        <div className="bg-surface border border-divider rounded-2xl py-16 text-center text-soft-mute text-sm">
          No submissions yet. Once students submit, results will appear here.
          <br />
          尚未有學生提交。一旦有提交，將顯示在此。
        </div>
      </div>
    );
  }

  // Aggregate stats across submitted/late only
  const completed = data.rows.filter(
    (r) => r.status === "Submitted" || r.status === "Late"
  );
  const avgPct =
    completed.length > 0
      ? completed.reduce((sum, r) => sum + (r.percentage ?? 0), 0) / completed.length
      : null;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <PageIntro tKey="teacher.results" />
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Student Results / 學生成績</h1>
        <p className="text-soft-mute text-sm mt-1">
          Cross-test consolidated view across all your tests. /
          跨所有測驗的學生作答統整。
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Tests / 測驗數" value={data.totals.tests} color="default" />
        <StatCard label="Students / 學生數" value={data.totals.students} color="blue" />
        <StatCard label="Submissions / 提交數" value={completed.length} color="lime" />
        <StatCard
          label="Avg Score / 平均分數"
          value={avgPct != null ? `${avgPct.toFixed(1)}%` : "—"}
          color="emerald"
        />
      </div>

      <CrossTestResultsTable
        rows={data.rows}
        testOptions={data.testOptions}
        classOptions={data.classOptions}
      />
    </div>
  );
}
