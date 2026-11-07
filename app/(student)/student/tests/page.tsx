import { getServiceClient } from "@/lib/supabase";
import { getQaTestIds, getQaUserIds, onSide } from "@/lib/qa";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { clsx } from "clsx";
import PageIntro from "@/components/shared/PageIntro";
import { formatShortDate } from "@/lib/datetime";
import { getAssignedTestIds, getInProgressOrPendingM2TestIds, isModule2Track } from "@/lib/student-exam";
import { getTestSections } from "@/lib/teacher-access";
import { attemptScore } from "@/lib/score-display";
import { ScoreCell } from "@/components/ui/ScoreCell";
import { StatusBadge, type AttemptStatus } from "@/components/ui/StatusBadge";
import { getTranslations } from "next-intl/server";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  EmptyRow,
  TwoLineCell,
} from "@/components/ui/data-table";

const MODULE_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
};

type TestSubmissionRow = {
  id: string;
  test_id: string;
  status: string;
  score: number | null;
  correct_count: number | null;
  total_questions: number | null;
  percentage: number | string | null;
  submitted_at: string | null;
  attempt_number: number | null;
  session_id: string | null;
  adaptive_track: string | null;
};

type TestAttemptModule = {
  label: string;
  submissionId: string;
  correctCount: number;
  totalQuestions: number;
  percentage: number | null;
  status: string;
};

type TestAttempt = {
  id: string;
  status: string;
  percentage: number | null;
  correctCount: number;
  totalQuestions: number;
  detailSubmissionId: string;
  isMultiModule: boolean;
  modules: TestAttemptModule[];
  // Set when at least one module is Submitted/Late but at least one
  // other module is still In Progress — surfaces the partial-result
  // CTA on the dashboard without losing the Resume affordance.
  partialResultSubmissionId: string | null;
};

// Two-module attempts span two submissions sharing session_id. Pick the
// latest attempt (by highest attempt_number) and roll its module siblings
// up so the row shows one combined headline plus a per-module split.
// Legacy single-module submissions (session_id NULL) stay as-is.
function buildLatestAttempt(rows: TestSubmissionRow[]): TestAttempt | null {
  if (rows.length === 0) return null;
  // Rows already arrive ordered by attempt_number desc; pick the most
  // recent attempt number, then collect every row sharing it.
  const latestAttempt = rows[0].attempt_number ?? 1;
  const sameAttempt = rows.filter(
    (r) => (r.attempt_number ?? 1) === latestAttempt,
  );

  const bySession = new Map<string, TestSubmissionRow[]>();
  const singletons: TestSubmissionRow[] = [];
  for (const r of sameAttempt) {
    if (r.session_id) {
      const list = bySession.get(r.session_id) ?? [];
      list.push(r);
      bySession.set(r.session_id, list);
    } else {
      singletons.push(r);
    }
  }

  // Prefer the multi-module session group when present; fall back to the
  // legacy single-row case otherwise.
  for (const list of bySession.values()) {
    if (list.length >= 2) {
      const sorted = [...list].sort((a, b) => {
        const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
        return rank(a.adaptive_track) - rank(b.adaptive_track);
      });
      const correct = sorted.reduce((s, r) => s + (r.correct_count ?? 0), 0);
      const total = sorted.reduce((s, r) => s + (r.total_questions ?? 0), 0);
      const pct =
        total > 0 ? Math.round((correct / total) * 1000) / 10 : null;
      const statuses = sorted.map((r) => r.status);
      const status = statuses.includes("In Progress")
        ? "In Progress"
        : statuses.includes("Late")
        ? "Late"
        : statuses[statuses.length - 1] ?? "Submitted";
      const modules: TestAttemptModule[] = sorted.map((r) => {
        const p = r.percentage != null ? Number(r.percentage) : null;
        return {
          label: MODULE_LABEL[r.adaptive_track ?? ""] ?? "Module",
          submissionId: r.id,
          correctCount: r.correct_count ?? 0,
          totalQuestions: r.total_questions ?? 0,
          percentage: p,
          status: r.status,
        };
      });
      // When the attempt is mid-flight (one module Submitted, the
      // other still In Progress) we still want a "view what's done so
      // far" button so the student isn't locked out of their Module 1
      // result. Pick the latest already-Submitted module as the
      // partial target.
      const hasMixed =
        modules.some(
          (m) => m.status === "Submitted" || m.status === "Late",
        ) && modules.some((m) => m.status === "In Progress");
      const partialResultSubmissionId = hasMixed
        ? modules.find(
            (m) => m.status === "Submitted" || m.status === "Late",
          )?.submissionId ?? null
        : null;
      return {
        id: sorted[0].session_id ?? sorted[0].id,
        status,
        percentage: pct,
        correctCount: correct,
        totalQuestions: total,
        // Link to the Module 2 (last) submission so the result page can
        // stitch both modules via session_id.
        detailSubmissionId: sorted[sorted.length - 1].id,
        isMultiModule: true,
        modules,
        partialResultSubmissionId,
      };
    }
  }

  const first = singletons[0] ?? sameAttempt[0];
  if (!first) return null;
  const p = first.percentage != null ? Number(first.percentage) : null;
  return {
    id: first.id,
    status: first.status,
    percentage: p,
    correctCount: first.correct_count ?? 0,
    totalQuestions: first.total_questions ?? 0,
    detailSubmissionId: first.id,
    isMultiModule: false,
    modules: [],
    partialResultSubmissionId: null,
  };
}

async function getStudentTests(studentId: string) {
  const db = getServiceClient();

  // Tests assigned directly or via one of the student's class groups.
  // Also include tests where the student has an unfinished attempt even if
  // they were later unassigned (resumeOnly).
  const [matchedTestIds, inProgressTestIds] = await Promise.all([
    getAssignedTestIds(db, studentId),
    getInProgressOrPendingM2TestIds(db, studentId),
  ]);

  // QA isolation: a student never sees a test from the other side.
  const [qaTests, qaUsers] = await Promise.all([getQaTestIds(), getQaUserIds()]);
  const isQaUser = qaUsers.has(studentId);
  for (const id of Array.from(matchedTestIds)) {
    if (!onSide(id, qaTests, isQaUser)) matchedTestIds.delete(id);
  }
  for (const id of Array.from(inProgressTestIds)) {
    if (!onSide(id, qaTests, isQaUser)) inProgressTestIds.delete(id);
  }

  // resumeOnly = in inProgressTestIds but NOT in matchedTestIds
  const resumeOnlyIds = new Set<string>();
  for (const id of inProgressTestIds) {
    if (!matchedTestIds.has(id)) resumeOnlyIds.add(id);
  }

  const allTestIds = new Set([...matchedTestIds, ...inProgressTestIds]);
  if (allTestIds.size === 0) return [];

  const testIds = Array.from(allTestIds);

  const [{ data: tests }, { data: submissions }, sectionOf] = await Promise.all([
    db.from("tests")
      .select(`
        id, test_name, status, due_date, time_limit_minutes, time_limit_minutes_module_2, is_untimed, is_adaptive, module_2_id,
        modules!module_id(module_name, section, module_number)
      `)
      .in("id", testIds)
      .in("status", ["Published", "Closed"])
      .order("due_date", { ascending: true }),
    db.from("submissions")
      .select(
        "test_id, id, status, score, correct_count, total_questions, percentage, submitted_at, attempt_number, session_id, adaptive_track",
      )
      .eq("student_id", studentId)
      .in("test_id", testIds)
      .order("attempt_number", { ascending: false }),
    getTestSections(db, testIds),
  ]);

  // Group submissions per test, then collapse two-module session
  // siblings into one attempt with module breakdown.
  const byTest = new Map<string, TestSubmissionRow[]>();
  for (const s of (submissions ?? []) as TestSubmissionRow[]) {
    const list = byTest.get(s.test_id) ?? [];
    list.push(s);
    byTest.set(s.test_id, list);
  }

  // A Closed test the student never started is just noise (often one
  // shared by mistake) — hide it. Closed tests they took stay so they
  // can still open their results.
  const visible = (tests ?? []).filter(
    (t) => t.status !== "Closed" || (byTest.get(t.id)?.length ?? 0) > 0,
  );

  return visible.map((t) => {
    const rows = byTest.get(t.id) ?? [];
    const attempt = buildLatestAttempt(rows);
    let testStatus = "Not Started";
    if (attempt) {
      if (attempt.status === "In Progress") testStatus = "In Progress";
      else if (attempt.status === "Submitted" || attempt.status === "Late")
        testStatus = "Submitted";
    }
    // Two-module attempt whose Module 1 is graded but whose Module 2 row
    // was never created (handoff failed / crashed). It is NOT finished:
    // the test page's "Continue to Module 2" recreates Module 2.
    const latestNo = rows[0]?.attempt_number ?? 1;
    const latestRows = rows.filter((r) => (r.attempt_number ?? 1) === latestNo);
    const needsModule2 =
      Boolean(t.is_adaptive || t.module_2_id) &&
      latestRows.some(
        (r) => r.adaptive_track === "module_1" && (r.status === "Submitted" || r.status === "Late"),
      ) &&
      !latestRows.some((r) => isModule2Track(r.adaptive_track));
    if (needsModule2) testStatus = "In Progress";
    // Latest submit time of the latest attempt, for "most recent first".
    const lastSubmittedAt = latestRows.reduce<string>((m, r) => (r.submitted_at && r.submitted_at > m ? r.submitted_at : m), "");
    // Same score display as everywhere else: SAT once every module is in,
    // per-module counts, unfinished modules as "—".
    const score = latestRows.length > 0
      ? attemptScore(latestRows.map((r) => ({ ...r, student_id: studentId })), sectionOf.get(t.id)).score
      : null;
    return { ...t, attempt, testStatus, needsModule2, lastSubmittedAt, score, resumeOnly: resumeOnlyIds.has(t.id) };
  });
}

// Determine whether the student is actively on Module 2 (M1 done, M2
// started or pending start) for the status and subject-tag label.
function computeOnModule2(test: {
  is_adaptive?: boolean | null;
  module_2_id?: string | null;
  needsModule2: boolean;
  attempt: TestAttempt | null;
}): boolean {
  const isTwoModule = Boolean(test.is_adaptive || test.module_2_id);
  if (!isTwoModule) return false;
  return (
    test.needsModule2 ||
    (test.attempt?.modules ?? []).some(
      (m) => m.label.startsWith("Module 2") && m.status === "In Progress",
    )
  );
}

function buildSubtitle(
  test: {
    is_adaptive?: boolean | null;
    module_2_id?: string | null;
    time_limit_minutes?: number | null;
    time_limit_minutes_module_2?: number | null;
    is_untimed?: boolean | null;
  },
  t: (key: string, values?: Record<string, number>) => string,
): string {
  const count = test.is_adaptive || test.module_2_id ? 2 : 1;
  const m1 = test.time_limit_minutes ?? 0;
  const minutes = count === 2 ? m1 + (test.time_limit_minutes_module_2 ?? m1) : m1;
  if (test.is_untimed || minutes <= 0) return t("subtitleUntimed", { count });
  return t("subtitleTimed", { count, minutes });
}

// Sort order: In Progress first, then Not Started, then Submitted.
// Within Submitted: most recently submitted first.
// Within unfinished: ascending due_date (most urgent first).
const STATUS_ORDER: Record<string, number> = {
  "In Progress": 0,
  "Not Started": 1,
  Submitted: 2,
};

export default async function StudentTestsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const [tests, t] = await Promise.all([
    getStudentTests(user.userId),
    getTranslations("student.tests"),
  ]);

  const sorted = [...tests].sort((a, b) => {
    const sa = STATUS_ORDER[a.testStatus] ?? 3;
    const sb = STATUS_ORDER[b.testStatus] ?? 3;
    if (sa !== sb) return sa - sb;
    if (a.testStatus === "Submitted") {
      // most recently submitted first
      return b.lastSubmittedAt.localeCompare(a.lastSubmittedAt);
    }
    // ascending due_date for unfinished (most urgent first; no date = later)
    const da = a.due_date ?? "9999-12-31";
    const db2 = b.due_date ?? "9999-12-31";
    return da.localeCompare(db2);
  });

  const hasDueDates = sorted.some((t2) => Boolean(t2.due_date));

  const COL_SPAN = hasDueDates ? 5 : 4;

  return (
    <div className="space-y-6">
      <PageIntro tKey="student.tests" />
      <h1 className="text-2xl font-bold text-charcoal">{t("title")}</h1>

      {sorted.length === 0 ? (
        <div className="py-16 text-center space-y-3 border-y border-divider">
          <ClipboardList size={40} className="text-charcoal/20 mx-auto" />
          <p className="text-soft-mute text-sm">{t("noTests")}</p>
        </div>
      ) : (
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">{t("columns.testName")}</Th>
              <Th>{t("columns.status")}</Th>
              {hasDueDates && <Th>{t("columns.dueDate")}</Th>}
              <Th>{t("columns.score")}</Th>
              <Th kind="actions" sticky="right">{t("columns.action")}</Th>
            </HeadRow>
          </thead>
          <tbody>
            {sorted.map((test) => {
              const mod = test.modules as unknown as
                | { module_name: string; section: string; module_number: number | null }
                | null;
              const isTwoModule = Boolean(test.is_adaptive || test.module_2_id);
              const onModule2 = computeOnModule2(test);
              const subtitle = buildSubtitle(test, t);

              // Subject tag label
              const section = mod?.section ?? (isTwoModule ? "Math" : null);
              const subjectLabel =
                section === "Math"
                  ? t("subject.math")
                  : section === "Reading & Writing"
                  ? t("subject.readingWriting")
                  : section ?? null;
              const subjectClass =
                section === "Math"
                  ? "bg-blue-50 text-blue-600 border border-blue-200"
                  : section === "Reading & Writing"
                  ? "bg-violet-50 text-violet-600 border border-violet-200"
                  : "bg-light-bg text-mid-gray border border-divider";

              // Status string (never wraps)
              const statusLabel =
                test.testStatus === "Submitted"
                  ? t("status.submitted")
                  : test.testStatus === "In Progress"
                  ? isTwoModule
                    ? onModule2
                      ? t("status.inProgressM2of2")
                      : t("status.inProgressM1of2")
                    : t("status.inProgress")
                  : t("status.notStarted");

              const badgeStatus: AttemptStatus =
                test.testStatus === "Submitted"
                  ? "Submitted"
                  : test.testStatus === "In Progress"
                  ? "In progress"
                  : "Not started";

              // Action: Continue covers resume + continue-to-module-2
              const continueHref =
                test.needsModule2 || test.testStatus !== "In Progress"
                  ? `/student/tests/${test.id}`
                  : `/student/tests/${test.id}/take`;

              return (
                <DataRow key={test.id} colSpan={COL_SPAN}>
                  <Td kind="main" sticky="left">
                    <Link
                      href={`/student/tests/${test.id}`}
                      className="block hover:text-warm-coral-text transition-colors"
                    >
                      <TwoLineCell
                        main={test.test_name}
                        detail={
                          <span className="flex items-center gap-1.5 flex-wrap">
                            {subjectLabel && (
                              <span
                                className={clsx(
                                  "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap",
                                  subjectClass,
                                )}
                              >
                                {subjectLabel}
                              </span>
                            )}
                            <span className="text-soft-mute text-xs">{subtitle}</span>
                          </span>
                        }
                        mainClassName="font-medium text-charcoal"
                      />
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge kind="attempt" status={badgeStatus} label={statusLabel} />
                  </Td>
                  {hasDueDates && (
                    <Td className="text-soft-mute">
                      {test.due_date ? formatShortDate(test.due_date) : "—"}
                    </Td>
                  )}
                  <Td>
                    <ScoreCell score={test.score} />
                  </Td>
                  <Td kind="actions" sticky="right">
                    {test.testStatus === "Submitted" ? (
                      <Link
                        href={`/student/tests/${test.id}/result`}
                        className="px-3 py-1.5 rounded-lg bg-surface text-mid-gray hover:text-charcoal hover:bg-light-bg text-xs font-medium whitespace-nowrap transition-colors"
                      >
                        {t("actions.viewResult")}
                      </Link>
                    ) : test.testStatus === "In Progress" || test.needsModule2 ? (
                      <div className="flex items-center gap-2">
                        <Link
                          href={continueHref}
                          className="px-3 py-1.5 rounded-lg bg-warm-coral/15 text-warm-coral-text hover:bg-warm-coral/25 text-xs font-medium whitespace-nowrap transition-colors"
                        >
                          {test.resumeOnly ? "Finish your attempt" : t("actions.continue")}
                        </Link>
                        {test.attempt?.partialResultSubmissionId && (
                          <Link
                            href={`/student/tests/${test.id}/result?submission=${test.attempt.partialResultSubmissionId}`}
                            className="px-3 py-1.5 rounded-lg bg-surface text-mid-gray hover:text-charcoal hover:bg-light-bg text-xs font-medium whitespace-nowrap transition-colors"
                          >
                            {t("actions.viewResult")}
                          </Link>
                        )}
                      </div>
                    ) : (
                      <Link
                        href={`/student/tests/${test.id}`}
                        className="px-3 py-1.5 rounded-lg bg-warm-amber/15 text-warm-amber hover:bg-warm-amber/25 text-xs font-medium whitespace-nowrap transition-colors"
                      >
                        {t("actions.start")}
                      </Link>
                    )}
                  </Td>
                </DataRow>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
