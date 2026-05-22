import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { clsx } from "clsx";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { scaleSectionScore } from "@/lib/scoring";

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
  scaledScore: number | null;
};

type TestAttempt = {
  id: string;
  status: string;
  percentage: number | null;
  scaledScore: number | null;
  correctCount: number;
  totalQuestions: number;
  detailSubmissionId: string;
  isMultiModule: boolean;
  modules: TestAttemptModule[];
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
          scaledScore: p != null ? scaleSectionScore(p) : null,
        };
      });
      return {
        id: sorted[0].session_id ?? sorted[0].id,
        status,
        percentage: pct,
        scaledScore: pct != null ? scaleSectionScore(pct) : null,
        correctCount: correct,
        totalQuestions: total,
        // Link to the Module 2 (last) submission so the result page can
        // stitch both modules via session_id.
        detailSubmissionId: sorted[sorted.length - 1].id,
        isMultiModule: true,
        modules,
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
    scaledScore: p != null ? scaleSectionScore(p) : null,
    correctCount: first.correct_count ?? 0,
    totalQuestions: first.total_questions ?? 0,
    detailSubmissionId: first.id,
    isMultiModule: false,
    modules: [],
  };
}

async function getStudentTests(studentId: string) {
  const db = getServiceClient();

  // Get student's class groups
  const { data: membership } = await db
    .from("class_group_members")
    .select("class_group_id")
    .eq("student_id", studentId);

  const classGroupIds = (membership ?? []).map((m) => m.class_group_id);

  const { data: allAssignments } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids");

  const matchedTestIds = new Set<string>();
  for (const a of allAssignments ?? []) {
    const sIds: string[] = a.student_ids ?? [];
    const cgIds: string[] = a.class_group_ids ?? [];
    if (sIds.includes(studentId) || classGroupIds.some((cg) => cgIds.includes(cg))) {
      matchedTestIds.add(a.test_id);
    }
  }

  if (matchedTestIds.size === 0) return [];

  const testIds = Array.from(matchedTestIds);

  const [{ data: tests }, { data: submissions }] = await Promise.all([
    db.from("tests")
      .select(`
        id, test_name, status, due_date, time_limit_minutes, is_adaptive,
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
  ]);

  // Group submissions per test, then collapse two-module session
  // siblings into one attempt with module breakdown.
  const byTest = new Map<string, TestSubmissionRow[]>();
  for (const s of (submissions ?? []) as TestSubmissionRow[]) {
    const list = byTest.get(s.test_id) ?? [];
    list.push(s);
    byTest.set(s.test_id, list);
  }

  return (tests ?? []).map((t) => {
    const rows = byTest.get(t.id) ?? [];
    const attempt = buildLatestAttempt(rows);
    let testStatus = "Not Started";
    if (attempt) {
      if (attempt.status === "In Progress") testStatus = "In Progress";
      else if (attempt.status === "Submitted" || attempt.status === "Late")
        testStatus = "Submitted";
    }
    return { ...t, attempt, testStatus };
  });
}

const testStatusStyles: Record<string, string> = {
  "Not Started": "bg-light-bg text-mid-gray",
  "In Progress": "bg-warm-coral/15 text-warm-coral",
  Submitted: "bg-warm-amber/15 text-warm-amber",
};

export default async function StudentTestsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const tests = await getStudentTests(user.userId);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageIntro tKey="student.tests" />
      <h1 className="text-2xl font-bold text-charcoal">My Tests</h1>

      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {tests.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <ClipboardList size={40} className="text-charcoal/20 mx-auto" />
            <p className="text-soft-mute text-sm">No tests assigned to you yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">Test Name</th>
                  <th className="text-left px-5 py-3 font-medium">Section</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Due Date</th>
                  <th className="text-left px-5 py-3 font-medium">Score</th>
                  <th className="text-left px-5 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((test) => {
                  const mod = test.modules as unknown as
                    | { module_name: string; section: string; module_number: number | null }
                    | null;
                  return (
                    <tr key={test.id} className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors">
                      <td className="px-5 py-3">
                        <Link href={`/student/tests/${test.id}`} className="text-charcoal font-medium hover:text-warm-coral transition-colors">
                          {test.test_name}
                        </Link>
                        <div className="text-soft-mute text-xs mt-0.5">
                          {mod ? mod.module_name : "Adaptive · multi-module"}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {mod ? <>{mod.section}{mod.module_number ? ` M${mod.module_number}` : ""}</> : "Math"}
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx("px-2 py-1 rounded-full text-xs font-medium", testStatusStyles[test.testStatus] ?? "bg-light-bg text-mid-gray")}>
                          {test.testStatus}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-soft-mute text-xs">
                        {test.due_date ? formatDate(test.due_date) : "—"}
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {test.attempt?.percentage != null ? (
                          <>
                            <div>{test.attempt.percentage.toFixed(1)}%</div>
                            {test.attempt.scaledScore != null && (
                              <div className="text-warm-coral text-xs font-medium">
                                {test.attempt.scaledScore}/800
                              </div>
                            )}
                            {test.attempt.isMultiModule &&
                              test.attempt.modules.length > 0 && (
                                <div className="text-soft-mute text-[11px] mt-0.5 leading-snug">
                                  {test.attempt.modules.map((m) => (
                                    <div key={m.submissionId}>
                                      {m.label}:{" "}
                                      {m.percentage != null
                                        ? `${m.percentage.toFixed(1)}%`
                                        : "—"}
                                      {" · "}
                                      {m.correctCount}/{m.totalQuestions}
                                    </div>
                                  ))}
                                </div>
                              )}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {test.testStatus === "Submitted" ? (
                          <Link
                            href={`/student/tests/${test.id}/result`}
                            className="px-3 py-1.5 rounded-lg bg-surface text-mid-gray hover:text-charcoal hover:bg-light-bg text-xs font-medium transition-colors"
                          >
                            View Result
                          </Link>
                        ) : test.testStatus === "In Progress" ? (
                          <Link
                            href={`/student/tests/${test.id}/take`}
                            className="px-3 py-1.5 rounded-lg bg-warm-coral/15 text-warm-coral hover:bg-warm-coral/25 text-xs font-medium transition-colors"
                          >
                            Resume
                          </Link>
                        ) : (
                          <Link
                            href={`/student/tests/${test.id}`}
                            className="px-3 py-1.5 rounded-lg bg-warm-amber/15 text-warm-amber hover:bg-warm-amber/25 text-xs font-medium transition-colors"
                          >
                            Start Test
                          </Link>
                        )}
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
