import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { BarChart2 } from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { scaleSectionScore } from "@/lib/scoring";

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

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageIntro tKey="student.results" />
      <h1 className="text-2xl font-bold text-charcoal">My Results</h1>

      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {results.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <BarChart2 size={40} className="text-charcoal/20 mx-auto" />
            <p className="text-soft-mute text-sm">No completed tests yet.</p>
            <Link
              href="/student/tests"
              className="inline-block mt-2 px-4 py-2 rounded-xl bg-warm-coral/15 text-warm-coral text-sm hover:bg-warm-coral/25 transition-colors"
            >
              Go to My Tests
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">Test</th>
                  <th className="text-left px-5 py-3 font-medium">Section</th>
                  <th className="text-left px-5 py-3 font-medium">Score</th>
                  <th className="text-left px-5 py-3 font-medium">Correct</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Submitted</th>
                  <th className="text-left px-5 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const pct = r.percentage;
                  return (
                    <tr key={r.key} className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors">
                      <td className="px-5 py-3">
                        <div className="text-charcoal font-medium">{r.testName}</div>
                        <div className="text-soft-mute text-xs">{r.moduleHeadline}</div>
                      </td>
                      <td className="px-5 py-3 text-mid-gray">{r.section ?? "—"}</td>
                      <td className="px-5 py-3">
                        {pct != null ? (
                          <>
                            <div className={clsx(
                              "font-bold",
                              pct >= 80 ? "text-warm-amber" : pct >= 60 ? "text-status-warning" : "text-status-error"
                            )}>
                              {pct.toFixed(1)}%
                            </div>
                            {r.scaledScore != null && (
                              <div className="text-warm-coral text-xs font-medium">
                                {r.scaledScore}/800
                              </div>
                            )}
                            {r.isMultiModule && r.modules.length > 0 && (
                              <div className="text-soft-mute text-[11px] mt-0.5 leading-snug font-normal">
                                {r.modules.map((m) => (
                                  <div key={m.submissionId}>
                                    {m.label}:{" "}
                                    {m.percentage != null
                                      ? `${m.percentage.toFixed(1)}%`
                                      : "—"}
                                    {m.scaledScore != null && ` · ${m.scaledScore}/800`}
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        ) : "—"}
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        <div>
                          {r.totalQuestions > 0
                            ? `${r.correctCount}/${r.totalQuestions}`
                            : "—"}
                        </div>
                        {r.isMultiModule && r.modules.length > 0 && (
                          <div className="text-soft-mute text-[11px] mt-0.5 leading-snug">
                            {r.modules.map((m) => (
                              <div key={m.submissionId}>
                                {m.label}: {m.correctCount}/{m.totalQuestions}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx(
                          "px-2 py-1 rounded-full text-xs font-medium",
                          r.status === "Submitted" ? "bg-warm-amber/15 text-warm-amber" : "bg-status-warning/15 text-status-warning"
                        )}>
                          {r.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-soft-mute text-xs">
                        {r.submittedAt ? formatDate(r.submittedAt) : "—"}
                      </td>
                      <td className="px-5 py-3">
                        <Link
                          href={`/student/tests/${r.testId}/result?submission=${r.detailSubmissionId}`}
                          className="px-3 py-1.5 rounded-lg bg-surface text-mid-gray hover:text-charcoal hover:bg-light-bg text-xs font-medium transition-colors"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
