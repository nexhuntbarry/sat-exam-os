import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { getAssignedStudentIds, getTeacherTestAccess, getTestSections } from "@/lib/teacher-access";
import { scopeUsers } from "@/lib/qa";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import ClassReviewButton from "@/components/tests/ClassReviewButton";
import { StatCard } from "@/components/analytics/StatCard";
import { ScoreDistributionChart } from "@/components/analytics/ScoreDistributionChart";
import { StudentResultsTable } from "@/components/analytics/StudentResultsTable";
import { ExportCsvButton } from "@/components/analytics/ExportCsvButton";
import ResultsDownloadPanel from "@/components/print/ResultsDownloadPanel";
import type { StudentResultRow } from "@/components/analytics/StudentResultsTable";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { attemptScore, averageSat } from "@/lib/score-display";
import { fullLengthLinksOrNone, type FullLengthChildren } from "@/lib/full-length";
import { averageFullLength, flFinished, flSectionScope } from "@/lib/full-length-score";
import { fullLengthTableRows, loadFullLengthResults } from "@/lib/full-length-results";
import { studentClassNames } from "@/lib/result-printout";
import { FullLengthResultsTable } from "@/components/analytics/FullLengthResultsTable";
import { tabSwitchTotal } from "@/lib/tab-switches";

async function getResultsData(testId: string, userId: string, role: string, isQa: boolean) {
  const db = getServiceClient();

  // Two-track access: direct (teacher_ids) or class-group teacher.
  const access = await getTeacherTestAccess(db, { userId, role, isQa }, testId);
  if (access.mode === null) return null;

  const { data: assignment } = await db
    .from("test_assignments")
    .select("student_ids, class_group_ids")
    .eq("test_id", testId)
    .maybeSingle();
  if (!assignment) return null;

  const { data: test } = await db
    .from("tests")
    .select("id, test_name, time_limit_minutes, due_date, status, modules!module_id(module_name, section, module_number)")
    .eq("id", testId)
    .single();

  if (!test) return null;

  // Assigned roster = student_ids ∪ class_group members, limited to the
  // class roster for a class-scoped teacher.
  const studentIds = await getAssignedStudentIds(
    db,
    assignment,
    isQa,
    access.mode === "class" ? access.studentAllowlist : null,
  );

  let subQuery = scopeUsers(db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, submitted_at, time_spent_seconds, attempt_number,
      scaled_score, scaled_section, session_id, adaptive_track,
      tab_switches:metadata->tab_switches,
      users!inner(display_name, email, student_profiles(grade, class_group))
    `)
    .eq("test_id", testId), isQa, "users.email")
    .order("submitted_at", { ascending: false });
  // A class-group teacher only sees their own class's attempts.
  if (access.mode === "class" && access.studentAllowlist) {
    subQuery = subQuery.in("student_id", Array.from(access.studentAllowlist));
  }
  const { data: submissions } = await subQuery;

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
    tab_switches: unknown;
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

  const section = (await getTestSections(db, [testId])).get(testId) ?? null;
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
    const attempt = attemptScore(sorted, section);
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
      retakePending: pendingSet.has(head.student_id),
      tabSwitches: tabSwitchTotal(sorted),
    });
  }

  // Sort newest-first to match the legacy submitted_at desc ordering.
  studentRows.sort((a, b) => {
    if (a.submittedAt && b.submittedAt) return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
  });

  // Averages / highest / lowest use finished attempts only.
  const submitted = studentRows.filter((r) => r.status === "Submitted" || r.status === "Late");
  const scored = submitted.filter((r) => r.sat != null);
  const avgSat = averageSat(scored.map((r) => r.sat));
  const pcts = scored.map((r) => r.percentage).filter((p): p is number => p != null);
  const avgPct = pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;

  const highestSub = scored.length > 0
    ? scored.reduce((a, b) => ((a.sat ?? 0) > (b.sat ?? 0) ? a : b))
    : null;
  const lowestSub = scored.length > 0
    ? scored.reduce((a, b) => ((a.sat ?? 0) < (b.sat ?? 0) ? a : b))
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

  const startedStudents = new Set(studentRows.map((r) => r.studentId));

  return {
    test,
    stats: {
      totalAssigned: studentIds.size,
      submittedCount: submitted.length,
      notStartedCount: Array.from(studentIds).filter((sid) => !startedStudents.has(sid)).length,
      inProgressCount: studentRows.filter((r) => r.status === "In progress").length,
      lateCount: studentRows.filter((r) => r.status === "Late").length,
      avgSat,
      avgPct,
      highestScore: highestSub ? { sat: highestSub.sat, name: highestSub.studentName } : null,
      lowestScore: lowestSub ? { sat: lowestSub.sat, name: lowestSub.studentName } : null,
      avgTimeSeconds: avgTime,
    },
    scoreDistribution: buckets,
    students: studentRows,
  };
}

// Full-length SAT parent (plan Phase 3): one row per attempt with the
// total, both sections and every module; a teacher scoped to one subject
// sees the total plus their own section.
async function getFullLengthResultsData(
  testId: string,
  children: FullLengthChildren,
  user: { userId: string; role: string; isQa: boolean },
) {
  const db = getServiceClient();
  const access = await getTeacherTestAccess(db, user, testId);
  if (access.mode === null) return null;
  const [{ data: assignment }, { data: test }] = await Promise.all([
    db.from("test_assignments").select("student_ids, class_group_ids").eq("test_id", testId).maybeSingle(),
    db.from("tests").select("id, test_name, due_date, status").eq("id", testId).single(),
  ]);
  if (!assignment || !test) return null;
  const allowlist = access.mode === "class" ? access.studentAllowlist : null;
  const [studentIds, attempts, scope, { data: grants }] = await Promise.all([
    getAssignedStudentIds(db, assignment, user.isQa, allowlist),
    loadFullLengthResults(db, testId, children, { studentAllowlist: allowlist, isQa: user.isQa }),
    flSectionScope(db, user, children),
    db.from("test_retake_grants").select("student_id").eq("test_id", testId).is("consumed_at", null),
  ]);
  const classOf = await studentClassNames(db, user, Array.from(new Set(attempts.map((a) => a.studentId))));
  const rows = fullLengthTableRows(attempts, {
    children,
    scope,
    classOf,
    retakePending: new Set((grants ?? []).map((g) => g.student_id as string)),
    sectionHref: (childId, subId) => `/teacher/tests/${childId}/results/${subId}`,
  });
  const scores = attempts.map((a) => a.score);
  const finished = scores.filter(flFinished);
  const totals = finished.map((s) => s.total).filter((t): t is number => t != null);
  const started = new Set(attempts.map((a) => a.studentId));
  return {
    test,
    scope,
    rows,
    stats: {
      totalAssigned: studentIds.size,
      submittedCount: finished.length,
      notStartedCount: Array.from(studentIds).filter((sid) => !started.has(sid)).length,
      inProgressCount: scores.filter((s) => s.status === "In progress" || s.status === "On break").length,
      closedCount: scores.filter((s) => s.status.startsWith("Closed")).length,
      lateCount: scores.filter((s) => s.status === "Late").length,
      avg: averageFullLength(scores),
      highest: totals.length ? Math.max(...totals) : null,
      lowest: totals.length ? Math.min(...totals) : null,
    },
  };
}

async function FullLengthResultsPage({
  id,
  kids,
  user,
}: {
  id: string;
  kids: FullLengthChildren;
  user: { userId: string; role: string; isQa: boolean };
}) {
  const data = await getFullLengthResultsData(id, kids, user);
  if (!data) notFound();
  const reviewLabel = (await getTranslations("teacher.classReview"))("button");
  const { test, scope, rows, stats } = data;
  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="flex items-center gap-2 text-soft-mute text-sm flex-wrap">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/teacher/tests/${id}`} className="hover:text-charcoal transition-colors">{test.test_name}</Link>
        <span>/</span>
        <span className="text-charcoal">Results</span>
      </div>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">{test.test_name} — Results</h1>
          <p className="text-soft-mute text-sm mt-1">
            Full-length SAT · Reading and Writing + Math · Total 400–1600
            {test.due_date && ` · Due ${formatDate(test.due_date)}`}
          </p>
          {!(scope.rw && scope.math) && (
            <p className="text-soft-mute text-xs mt-1">
              You see the total and the {scope.math ? "Math" : "Reading and Writing"} section.
            </p>
          )}
        </div>
        <div className="flex items-start gap-3 flex-wrap">
          <ClassReviewButton testId={id} label={reviewLabel} />
          <ExportCsvButton
            testId={id}
            filename={`${test.test_name.replace(/[^a-z0-9]/gi, "_")}-results.csv`}
          />
          <Link
            href={`/teacher/tests/${id}/analytics`}
            className="px-4 py-2 rounded-xl bg-warm-coral/10 border border-warm-coral/20 text-warm-coral-text text-sm font-medium hover:bg-warm-coral/20 transition-colors"
          >
            Question Analytics
          </Link>
        </div>
      </div>

      <ResultsDownloadPanel testId={id} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total Assigned" value={stats.totalAssigned} color="default" />
        <StatCard
          label="Submitted"
          value={`${stats.submittedCount}`}
          sub={stats.totalAssigned > 0 ? `${((stats.submittedCount / stats.totalAssigned) * 100).toFixed(0)}%` : undefined}
          color="lime"
        />
        <StatCard label="Not Started" value={stats.notStartedCount} color="default" />
        <StatCard label="In Progress" value={stats.inProgressCount} sub="includes the break" color="blue" />
        <StatCard label="Late Submissions" value={stats.lateCount} color="amber" />
        <StatCard label="Closed" value={stats.closedCount} sub="Math not taken" color="default" />
        <StatCard label="Avg Total" value={stats.avg.total ?? "—"} sub="out of 1600" color="emerald" />
        {scope.rw && <StatCard label="Avg R&W" value={stats.avg.rw ?? "—"} color="emerald" />}
        {scope.math && <StatCard label="Avg Math" value={stats.avg.math ?? "—"} color="emerald" />}
        <StatCard label="Highest Total" value={stats.highest ?? "—"} color="lime" />
        <StatCard label="Lowest Total" value={stats.lowest ?? "—"} color="rose" />
      </div>

      <div>
        <h2 className="text-charcoal font-semibold text-lg mb-4">Student Results</h2>
        <FullLengthResultsTable rows={rows} testId={id} scope={scope} />
      </div>
    </div>
  );
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
  const flLinks = await fullLengthLinksOrNone(getServiceClient());
  // A full-length section's results live on its parent.
  const flParent = flLinks.parentOf.get(id);
  if (flParent) redirect(`/teacher/tests/${flParent}/results`);
  const flKids = flLinks.childrenOf.get(id);
  if (flKids) {
    return <FullLengthResultsPage id={id} kids={flKids} user={{ userId: user.userId, role: user.role ?? "", isQa: user.isQa }} />;
  }
  const data = await getResultsData(id, user.userId, user.role ?? "", user.isQa);
  if (!data) notFound();
  const reviewLabel = (await getTranslations("teacher.classReview"))("button");

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
        <div className="flex items-start gap-3 flex-wrap">
          <ClassReviewButton testId={id} label={reviewLabel} />
          <ExportCsvButton
            testId={id}
            filename={`${test.test_name.replace(/[^a-z0-9]/gi, "_")}-results.csv`}
          />
          <Link
            href={`/teacher/tests/${id}/analytics`}
            className="px-4 py-2 rounded-xl bg-warm-coral/10 border border-warm-coral/20 text-warm-coral-text text-sm font-medium hover:bg-warm-coral/20 transition-colors"
          >
            Question Analytics
          </Link>
        </div>
      </div>

      <ResultsDownloadPanel testId={id} />

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
          label="Avg SAT"
          value={stats.avgSat ?? "—"}
          sub={stats.avgPct != null ? `${stats.avgPct.toFixed(1)}% correct` : undefined}
          color="emerald"
        />
        <StatCard
          label="Highest SAT"
          value={stats.highestScore?.sat ?? "—"}
          sub={stats.highestScore?.name}
          color="lime"
        />
        <StatCard
          label="Lowest SAT"
          value={stats.lowestScore?.sat ?? "—"}
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
