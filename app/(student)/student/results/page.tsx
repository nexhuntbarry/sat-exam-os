import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { BarChart2, Eye } from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";
import { formatShortDate } from "@/lib/datetime";
import { scaleSectionScore } from "@/lib/scoring";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import ProgressReport from "@/components/analytics/ProgressReport";
import ScoreProgressChart from "@/components/analytics/ScoreProgressChart";
import PerTestBreakdown from "@/components/analytics/PerTestBreakdown";
import { getStudentBreakdownRows, getStudentProgressOccasions } from "@/lib/student-analytics";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  EmptyRow,
  RowButton,
  TwoLineCell,
} from "@/components/ui/data-table";

const MODULE_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
};

type ResultRow = {
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
  tests: {
    test_name: string;
    modules: { module_name: string; section: string } | null;
  };
};

type ModuleView = {
  label: string;
  submissionId: string;
  correctCount: number;
  totalQuestions: number;
  percentage: number | null;
  scaledScore: number | null;
};

type ResultGroup = {
  key: string;
  testId: string;
  testName: string;
  section: string | null;
  moduleHeadline: string;
  status: string;
  correctCount: number;
  totalQuestions: number;
  percentage: number | null;
  scaledScore: number | null;
  submittedAt: string | null;
  detailSubmissionId: string;
  isMultiModule: boolean;
  modules: ModuleView[];
};

async function getStudentResults(studentId: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("submissions")
    .select(`
      id, test_id, status, score, correct_count, total_questions,
      percentage, submitted_at, attempt_number, session_id, adaptive_track,
      tests!inner(test_name, modules!module_id(module_name, section))
    `)
    .eq("student_id", studentId)
    .in("status", ["Submitted", "Late"])
    .order("submitted_at", { ascending: false });
  return (data ?? []) as unknown as ResultRow[];
}

// Two-module attempts (adaptive or non-adaptive two-module tests) span
// two submission rows sharing one session_id. Roll them up into one
// row with a combined headline plus a per-module split. Legacy
// single-module submissions (session_id NULL) stay as individual rows.
function buildResultGroups(rows: ResultRow[]): ResultGroup[] {
  const bySession = new Map<string, ResultRow[]>();
  const singletons: ResultRow[] = [];
  for (const r of rows) {
    if (r.session_id) {
      const list = bySession.get(r.session_id) ?? [];
      list.push(r);
      bySession.set(r.session_id, list);
    } else {
      singletons.push(r);
    }
  }

  const toModuleView = (r: ResultRow): ModuleView => {
    const p = r.percentage != null ? Number(r.percentage) : null;
    return {
      label: MODULE_LABEL[r.adaptive_track ?? ""] ?? "Module",
      submissionId: r.id,
      correctCount: r.correct_count ?? 0,
      totalQuestions: r.total_questions ?? 0,
      percentage: p,
      scaledScore: p != null ? scaleSectionScore(p) : null,
    };
  };

  const groups: ResultGroup[] = singletons.map((r) => {
    const p = r.percentage != null ? Number(r.percentage) : null;
    return {
      key: r.id,
      testId: r.test_id,
      testName: r.tests.test_name,
      section: r.tests.modules?.section ?? null,
      moduleHeadline:
        r.tests.modules?.module_name ?? "Adaptive · multi-module",
      status: r.status,
      correctCount: r.correct_count ?? 0,
      totalQuestions: r.total_questions ?? 0,
      percentage: p,
      scaledScore: p != null ? scaleSectionScore(p) : null,
      submittedAt: r.submitted_at,
      detailSubmissionId: r.id,
      isMultiModule: false,
      modules: [],
    };
  });

  for (const [sessionId, list] of bySession) {
    if (list.length === 1) {
      const r = list[0];
      const p = r.percentage != null ? Number(r.percentage) : null;
      groups.push({
        key: r.id,
        testId: r.test_id,
        testName: r.tests.test_name,
        section: r.tests.modules?.section ?? null,
        moduleHeadline:
          r.tests.modules?.module_name ?? "Adaptive · multi-module",
        status: r.status,
        correctCount: r.correct_count ?? 0,
        totalQuestions: r.total_questions ?? 0,
        percentage: p,
        scaledScore: p != null ? scaleSectionScore(p) : null,
        submittedAt: r.submitted_at,
        detailSubmissionId: r.id,
        isMultiModule: false,
        modules: [],
      });
      continue;
    }
    const sorted = [...list].sort((a, b) => {
      const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
      return rank(a.adaptive_track) - rank(b.adaptive_track);
    });
    const correct = sorted.reduce((s, r) => s + (r.correct_count ?? 0), 0);
    const total = sorted.reduce((s, r) => s + (r.total_questions ?? 0), 0);
    const pct =
      total > 0 ? Math.round((correct / total) * 1000) / 10 : null;
    const statuses = sorted.map((r) => r.status);
    const status = statuses.includes("Late")
      ? "Late"
      : statuses[statuses.length - 1] ?? "Submitted";
    const lastSubmittedAt =
      sorted
        .map((r) => r.submitted_at)
        .filter((d): d is string => !!d)
        .sort()
        .pop() ?? null;
    groups.push({
      key: sessionId,
      testId: sorted[0].test_id,
      testName: sorted[0].tests.test_name,
      section: sorted[0].tests.modules?.section ?? null,
      moduleHeadline: "Module 1 + Module 2",
      status,
      correctCount: correct,
      totalQuestions: total,
      percentage: pct,
      scaledScore: pct != null ? scaleSectionScore(pct) : null,
      submittedAt: lastSubmittedAt,
      detailSubmissionId: sorted[sorted.length - 1].id,
      isMultiModule: true,
      modules: sorted.map(toModuleView),
    });
  }

  groups.sort((a, b) => {
    if (a.submittedAt && b.submittedAt)
      return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
  });

  return groups;
}

export default async function StudentResultsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const rows = await getStudentResults(user.userId);
  const results = buildResultGroups(rows);
  const breakdownRows = await getStudentBreakdownRows(user.userId);
  const occasions = await getStudentProgressOccasions(user.userId);

  return (
    <div className="space-y-6">
      <PageIntro tKey="student.results" />
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-charcoal">My Results</h1>
        {occasions.length > 0 && (
          <Link href="/report" className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-divider text-sm font-semibold text-charcoal hover:bg-light-bg transition-colors">
            Download PDF report
          </Link>
        )}
      </div>

      {/* Overall strengths/weaknesses across every test taken. */}
      {breakdownRows.length > 0 && (
        <ScoreBreakdown rows={breakdownRows} title="Your Strengths & Focus Areas — Overall" />
      )}

      {/* Progress over time — are the weak areas improving? */}
      {occasions.length > 1 && <ScoreProgressChart occasions={occasions} />}
      {occasions.length > 0 && <ProgressReport occasions={occasions} title="Your Progress Over Time" />}

      {/* Per-test score report — each test's own breakdown, expandable. */}
      {occasions.length > 0 && <PerTestBreakdown occasions={occasions} title="Score Report — By Test" />}

      <h2 className="text-lg font-semibold text-charcoal pt-2">Test History</h2>

      {results.length === 0 ? (
        <div className="py-16 text-center space-y-3 border-y border-divider">
          <BarChart2 size={40} className="text-charcoal/20 mx-auto" />
          <p className="text-soft-mute text-sm">No completed tests yet.</p>
          <Link
            href="/student/tests"
            className="inline-block mt-2 px-4 py-2 rounded-xl bg-warm-coral/15 text-warm-coral-text text-sm hover:bg-warm-coral/25 transition-colors"
          >
            Go to My Tests
          </Link>
        </div>
      ) : (
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">Test</Th>
              <Th priority="md">Section</Th>
              <Th>Score</Th>
              <Th priority="md">Correct</Th>
              <Th>Status</Th>
              <Th priority="md">Submitted</Th>
              <Th kind="actions" sticky="right"><span className="sr-only">Action</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {results.map((r) => {
              const pct = r.percentage;
              const scoreMain = pct != null
                ? <span className={clsx("font-bold", pct >= 80 ? "text-warm-amber" : pct >= 60 ? "text-status-warning" : "text-status-error")}>{pct.toFixed(1)}%</span>
                : <span className="text-soft-mute">—</span>;
              const scoreDetail = r.scaledScore != null ? `${r.scaledScore}/800` : undefined;
              const moduleScoreBreakdown = r.isMultiModule && r.modules.length > 0
                ? r.modules.map((m) => `${m.label}: ${m.percentage != null ? `${m.percentage.toFixed(1)}%` : "—"}${m.scaledScore != null ? ` · ${m.scaledScore}/800` : ""}`).join(" | ")
                : undefined;
              const correctMain = r.totalQuestions > 0 ? `${r.correctCount}/${r.totalQuestions}` : "—";
              const moduleCorrectBreakdown = r.isMultiModule && r.modules.length > 0
                ? r.modules.map((m) => `${m.label}: ${m.correctCount}/${m.totalQuestions}`).join(" | ")
                : undefined;

              const resultHref = `/student/tests/${r.testId}/result?submission=${r.detailSubmissionId}`;

              return (
                <DataRow key={r.key} href={resultHref} colSpan={7}>
                  <Td kind="main" sticky="left">
                    <TwoLineCell
                      main={r.testName}
                      detail={r.moduleHeadline}
                      mainClassName="font-medium text-charcoal"
                    />
                  </Td>
                  <Td priority="md" className="text-mid-gray">
                    {r.section ?? "—"}
                  </Td>
                  <Td>
                    <TwoLineCell
                      main={scoreMain}
                      detail={scoreDetail ?? moduleScoreBreakdown}
                    />
                  </Td>
                  <Td priority="md" className="text-mid-gray">
                    <TwoLineCell
                      main={correctMain}
                      detail={moduleCorrectBreakdown}
                      mainClassName="text-mid-gray"
                    />
                  </Td>
                  <Td>
                    <span className={clsx(
                      "px-2 py-0.5 rounded-full text-xs font-medium",
                      r.status === "Submitted" ? "bg-warm-amber/15 text-warm-amber" : "bg-status-warning/15 text-status-warning"
                    )}>
                      {r.status}
                    </span>
                  </Td>
                  <Td priority="md" className="text-soft-mute">
                    {r.submittedAt ? formatShortDate(r.submittedAt) : "—"}
                  </Td>
                  <Td kind="actions" sticky="right">
                    <RowButton label="View result" href={resultHref} icon={<Eye size={13} />} />
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
