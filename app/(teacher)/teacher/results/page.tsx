import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/auth";
import { scopeUsers } from "@/lib/qa";
import { getTeacherTestScope, getTestSections, seesAllStudents } from "@/lib/teacher-access";
import { getServiceClient } from "@/lib/supabase";
import { StatCard } from "@/components/analytics/StatCard";
import {
  CrossTestResultsTable,
  type CrossTestResultRow,
} from "@/components/analytics/CrossTestResultsTable";
import PageIntro from "@/components/shared/PageIntro";
import { averageSat } from "@/lib/score-display";
import { expandWithChildren, fullLengthLinksOrNone } from "@/lib/full-length";
import {
  attemptGroupKey,
  FL_ALL_SECTIONS,
  flSectionScope,
  listedTestId,
  loadFlAttemptMeta,
  scoreAttemptGroup,
  type FlSectionScope,
} from "@/lib/full-length-score";

async function getCrossTestResults(teacherId: string, role: string, isQa: boolean) {
  const db = getServiceClient();

  // 1. Visible tests: the shared teacher scope (direct ∪ class-assigned /
  // class-taken), subject-scoped like getTeacherTestAccess so a Math-only
  // teacher never sees R&W results here while the API returns 403 for them.
  const scope = await getTeacherTestScope(db, { userId: teacherId, role, isQa });
  const visibleTestIds = scope.testIds;

  if (visibleTestIds.size === 0) {
    return { rows: [], testOptions: [], classOptions: [], totals: { tests: 0, submissions: 0, students: 0 } };
  }

  const testIds = Array.from(visibleTestIds);

  // 2. Get test metadata (section covers adaptive tests too)
  const [{ data: tests }, sectionOf] = await Promise.all([
    db.from("tests").select("id, test_name").in("id", testIds),
    getTestSections(db, testIds),
  ]);

  const testMap = new Map<string, { name: string; section: string | null }>();
  for (const t of tests ?? []) {
    testMap.set(t.id, { name: t.test_name, section: sectionOf.get(t.id) ?? null });
  }

  // 3. Get all submissions for these tests (a full-length SAT's are on its
  // two section children; they're listed under the parent, one row per
  // full-length attempt with the total).
  const flLinks = await fullLengthLinksOrNone(db);
  const flParents = testIds.filter((id) => flLinks.childrenOf.has(id));
  const flMeta = await loadFlAttemptMeta(db, flParents);
  // A single-subject teacher sees the total plus their own section only.
  const flScopes = new Map<string, FlSectionScope>(
    await Promise.all(
      flParents.map(async (pid) => [pid, await flSectionScope(db, { userId: teacherId, role, isQa }, flLinks.childrenOf.get(pid)!)] as const),
    ),
  );
  const { data: submissions } = await scopeUsers(db
    .from("submissions")
    .select(
      `
      id, test_id, student_id, status, score, correct_count, total_questions,
      percentage, scaled_score, scaled_section, submitted_at, time_spent_seconds,
      session_id, adaptive_track, attempt_number,
      users!inner(display_name, email)
    `
    )
    .in("test_id", expandWithChildren(testIds, flLinks)), isQa, "users.email")
    .order("submitted_at", { ascending: false });

  // Non-admin filter: keep a submission only if EITHER the test was
  // directly assigned to the teacher (then any student is fair game,
  // legacy semantics) OR the submitting student is in one of the
  // teacher's class_groups. Without this, the class-group-derived test
  // set would leak co-students from other classes who happened to
  // take the same test.
  const subs = (submissions ?? []).filter((s) => {
    if (seesAllStudents(scope, listedTestId(s.test_id as string, flLinks))) return true;
    return scope.myStudentIds.has(s.student_id as string);
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

  // Two-module attempts produce two submission rows sharing a
  // session_id. Group siblings so each cross-test row represents one
  // attempt with a combined headline plus per-module split — otherwise
  // the same student would show up twice for the same test.
  type SubRow = (typeof subs)[number] & {
    session_id: string | null;
    adaptive_track: string | null;
  };
  const sessionGroups = new Map<string, SubRow[]>();
  for (const s of subs as SubRow[]) {
    const key = attemptGroupKey(s, flLinks);
    const list = sessionGroups.get(key) ?? [];
    list.push(s);
    sessionGroups.set(key, list);
  }

  const rows: CrossTestResultRow[] = [];
  for (const list of sessionGroups.values()) {
    const sorted = [...list].sort((a, b) => {
      const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
      return rank(a.adaptive_track) - rank(b.adaptive_track);
    });
    const head = sorted[0];
    const u = head.users as unknown as { display_name: string; email: string };
    const testId = listedTestId(head.test_id, flLinks);
    const meta = testMap.get(testId) ?? { name: "(unknown test)", section: null };

    const attempt = scoreAttemptGroup(sorted, flLinks, meta.section, flMeta, (pid) => flScopes.get(pid) ?? FL_ALL_SECTIONS);
    rows.push({
      // Link to the Module 2 (last) submission so the result detail
      // page can stitch both modules via session_id.
      submissionId: sorted[sorted.length - 1].id,
      testId,
      testName: meta.name,
      section: attempt.fullLength ? "Full-length SAT" : meta.section,
      ...(attempt.fullLength ? { fullLength: true, detailHref: `/teacher/tests/${testId}/results` } : {}),
      studentId: head.student_id,
      studentName: u.display_name,
      email: u.email,
      classGroup: classMap.get(head.student_id) ?? null,
      status: attempt.status,
      module: attempt.module,
      score: attempt.score,
      sat: attempt.score?.sat ?? null,
      percentage: attempt.score?.pct ?? null,
      timeSpentSeconds: sorted.some((r) => r.time_spent_seconds != null)
        ? sorted.reduce((s, r) => s + (r.time_spent_seconds ?? 0), 0)
        : null,
      submittedAt:
        sorted
          .map((r) => r.submitted_at)
          .filter((d): d is string => !!d)
          .sort()
          .pop() ?? null,
    });
  }

  // Sort newest-first to preserve the original submitted_at desc order.
  rows.sort((a, b) => {
    if (a.submittedAt && b.submittedAt) return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
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
    getCrossTestResults(user.userId, user.role ?? "", user.isQa),
    getTranslations("teacherResults"),
  ]);

  if (data.totals.tests === 0) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center space-y-6">
        <PageIntro tKey="teacher.results" />
        <div className="inline-flex p-5 rounded-2xl bg-warm-coral/10 border border-warm-coral/20">
          <ClipboardList size={36} className="text-warm-coral-text" />
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

  // Aggregate stats across finished attempts only
  const completed = data.rows.filter(
    (r) => r.status === "Submitted" || r.status === "Late"
  );
  // Full-length totals (400–1600) are on another scale: left out of the SAT average.
  const sectionCompleted = completed.filter((r) => !r.fullLength);
  const avgSat = averageSat(sectionCompleted.map((r) => r.sat));
  const pcts = sectionCompleted.map((r) => r.percentage).filter((p): p is number => p != null);
  const avgPct = pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;

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
          value={avgSat ?? "—"}
          sub={avgPct != null ? t("stats.pctCorrect", { pct: avgPct.toFixed(1) }) : undefined}
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
