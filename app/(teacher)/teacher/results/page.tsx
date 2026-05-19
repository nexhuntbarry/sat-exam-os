import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { getTranslations } from "next-intl/server";
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

  // 1. Build the visible test set. Admin sees everything. A teacher sees
  // (a) tests they're directly assigned to AND (b) every test that any
  // student in their class_groups has a submission for — that's what
  // "my students' results" actually means once admin creates tests
  // without putting the teacher on test_assignments.teacher_ids.
  let visibleTestIds = new Set<string>();
  // Tracks the student-id allowlist for the non-admin "class group"
  // path. Submissions in this set show even if their test isn't on the
  // direct-assignment list. Empty for admin (no filter).
  const myStudentIds = new Set<string>();
  // Tests where the teacher is on the test_assignments.teacher_ids
  // array directly. For those, ANY submission shows (legacy behavior).
  const directTestIds = new Set<string>();

  if (role === "admin") {
    const { data: all } = await db.from("test_assignments").select("test_id");
    visibleTestIds = new Set((all ?? []).map((a) => a.test_id as string));
  } else {
    const { data: directly } = await db
      .from("test_assignments")
      .select("test_id")
      .contains("teacher_ids", JSON.stringify([teacherId]));
    for (const a of directly ?? []) {
      visibleTestIds.add(a.test_id as string);
      directTestIds.add(a.test_id as string);
    }

    // Class-group derived: every test any of my students has a
    // submission for.
    const { data: myGroups } = await db
      .from("class_group_teachers")
      .select("class_group_id")
      .eq("teacher_id", teacherId);
    const groupIds = (myGroups ?? []).map((g) => g.class_group_id as string);
    if (groupIds.length > 0) {
      const { data: members } = await db
        .from("class_group_members")
        .select("student_id")
        .in("class_group_id", groupIds);
      for (const m of members ?? []) myStudentIds.add(m.student_id as string);
      if (myStudentIds.size > 0) {
        const { data: studentSubs } = await db
          .from("submissions")
          .select("test_id")
          .in("student_id", Array.from(myStudentIds));
        for (const s of studentSubs ?? []) visibleTestIds.add(s.test_id as string);
      }
    }
  }

  if (visibleTestIds.size === 0) {
    return { rows: [], testOptions: [], classOptions: [], totals: { tests: 0, submissions: 0, students: 0 } };
  }

  const testIds = Array.from(visibleTestIds);

  // 2. Get test metadata
  const { data: tests } = await db
    .from("tests")
    .select(`id, test_name, modules!module_id(section, module_name)`)
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
      percentage, scaled_score, scaled_section, submitted_at, time_spent_seconds,
      users!inner(display_name, email)
    `
    )
    .in("test_id", testIds)
    .order("submitted_at", { ascending: false });

  // Non-admin filter: keep a submission only if EITHER the test was
  // directly assigned to the teacher (then any student is fair game,
  // legacy semantics) OR the submitting student is in one of the
  // teacher's class_groups. Without this, the class-group-derived test
  // set would leak co-students from other classes who happened to
  // take the same test.
  const subs = (submissions ?? []).filter((s) => {
    if (role === "admin") return true;
    if (directTestIds.has(s.test_id as string)) return true;
    return myStudentIds.has(s.student_id as string);
  });

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
      scaledScore: s.scaled_score ?? null,
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

  const [data, t] = await Promise.all([
    getCrossTestResults(user.userId, user.role ?? ""),
    getTranslations("teacherResults"),
  ]);

  if (data.totals.tests === 0) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center space-y-6">
        <PageIntro tKey="teacher.results" />
        <div className="inline-flex p-5 rounded-2xl bg-warm-coral/10 border border-warm-coral/20">
          <ClipboardList size={36} className="text-warm-coral" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-charcoal">{t("title")}</h1>
          <p className="text-soft-mute text-sm">{t("emptyBody")}</p>
        </div>
        <Link
          href="/teacher/teaching-mode"
          className="inline-block px-5 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white text-sm font-semibold transition-colors"
        >
          {t("createCta")}
        </Link>
      </div>
    );
  }

  if (data.rows.length === 0) {
    return (
      <div className="max-w-5xl mx-auto space-y-6">
        <PageIntro tKey="teacher.results" />
        <div>
          <h1 className="text-2xl font-bold text-charcoal">{t("title")}</h1>
          <p className="text-soft-mute text-sm mt-1">{t("subtitle")}</p>
        </div>
        <div className="bg-surface border border-divider rounded-2xl py-16 text-center text-soft-mute text-sm">
          {t("noSubmissions")}
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
        <h1 className="text-2xl font-bold text-charcoal">{t("title")}</h1>
        <p className="text-soft-mute text-sm mt-1">{t("subtitle")}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label={t("stats.tests")} value={data.totals.tests} color="default" />
        <StatCard label={t("stats.students")} value={data.totals.students} color="blue" />
        <StatCard label={t("stats.submissions")} value={completed.length} color="lime" />
        <StatCard
          label={t("stats.avgScore")}
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
