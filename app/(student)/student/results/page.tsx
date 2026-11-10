import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { BarChart2, Eye } from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";
import { formatShortDate } from "@/lib/datetime";
import { getTestSections } from "@/lib/teacher-access";
import { fullLengthLinksOrNone } from "@/lib/full-length";
import { attemptScore, type AttemptScore } from "@/lib/score-display";
import { ScoreCell } from "@/components/ui/ScoreCell";
import { StatusBadge } from "@/components/ui/StatusBadge";
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

type ResultRow = {
  id: string;
  test_id: string;
  student_id: string;
  status: string;
  correct_count: number | null;
  total_questions: number | null;
  submitted_at: string | null;
  session_id: string | null;
  adaptive_track: string | null;
  tests: {
    test_name: string;
    modules: { module_name: string; section: string } | null;
  };
};

type ResultGroup = {
  key: string;
  testId: string;
  testName: string;
  section: string | null;
  moduleHeadline: string;
  attempt: AttemptScore;
  submittedAt: string | null;
  detailSubmissionId: string;
};

async function getStudentResults(studentId: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("submissions")
    .select(`
      id, test_id, student_id, status, correct_count, total_questions,
      submitted_at, session_id, adaptive_track,
      tests!inner(test_name, modules!module_id(module_name, section))
    `)
    .eq("student_id", studentId)
    .in("status", ["Submitted", "Late"])
    .order("submitted_at", { ascending: false });
  const rows = (data ?? []) as unknown as ResultRow[];
  const testIds = Array.from(new Set(rows.map((r) => r.test_id)));
  // Full-length SAT section rows link to the parent test (fail-open: on a
  // lookup error they keep their own test id, which redirects anyway).
  const [sectionOf, flLinks] = await Promise.all([getTestSections(db, testIds), fullLengthLinksOrNone(db)]);
  const parents = flLinks.parentOf;
  return { rows, sectionOf, parents };
}

// Two-module attempts (adaptive or non-adaptive two-module tests) span
// two submission rows sharing one session_id: one row per attempt, scored
// with the shared score display. Legacy single-module submissions
// (session_id NULL) stay as individual rows.
function buildResultGroups(rows: ResultRow[], sectionOf: Map<string, string | null>): ResultGroup[] {
  const bySession = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const key = r.session_id ?? `solo:${r.id}`;
    bySession.set(key, [...(bySession.get(key) ?? []), r]);
  }

  const groups: ResultGroup[] = [];
  for (const [key, list] of bySession) {
    const sorted = [...list].sort((a, b) => {
      const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
      return rank(a.adaptive_track) - rank(b.adaptive_track);
    });
    const head = sorted[0];
    const section = sectionOf.get(head.test_id) ?? head.tests.modules?.section ?? null;
    const twoModules = sorted.some((r) => Boolean(r.adaptive_track));
    groups.push({
      key,
      testId: head.test_id,
      testName: head.tests.test_name,
      section,
      moduleHeadline: twoModules
        ? "Module 1 + Module 2"
        : head.tests.modules?.module_name ?? "Adaptive · multi-module",
      attempt: attemptScore(sorted, section),
      submittedAt:
        sorted
          .map((r) => r.submitted_at)
          .filter((d): d is string => !!d)
          .sort()
          .pop() ?? null,
      // The last (Module 2) row so the result page stitches both modules.
      detailSubmissionId: sorted[sorted.length - 1].id,
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

  const { rows, sectionOf, parents } = await getStudentResults(user.userId);
  const results = buildResultGroups(rows, sectionOf).map((g) =>
    parents.has(g.testId) ? { ...g, testId: parents.get(g.testId)! } : g,
  );
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
              <Th>Status</Th>
              <Th priority="md">Submitted</Th>
              <Th kind="actions" sticky="right"><span className="sr-only">Action</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {results.map((r) => {
              const resultHref = `/student/tests/${r.testId}/result?submission=${r.detailSubmissionId}`;

              return (
                <DataRow key={r.key} href={resultHref} colSpan={6}>
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
                    <ScoreCell score={r.attempt.score} />
                  </Td>
                  <Td>
                    <StatusBadge kind="attempt" status={r.attempt.status} module={r.attempt.module} />
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
