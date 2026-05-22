import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { scaleSectionScore } from "@/lib/scoring";
import ReviewModeToggle from "@/components/tests/ReviewModeToggle";

const MODULE_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
};

async function getTeacherTest(testId: string, teacherId: string) {
  const db = getServiceClient();

  // Verify teacher is assigned
  const { data: assignment } = await db
    .from("test_assignments")
    .select("test_id, teacher_ids, student_ids, class_group_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) return null;
  const teacherIds: string[] = assignment.teacher_ids ?? [];
  if (!teacherIds.includes(teacherId)) return null;

  const { data: test } = await db
    .from("tests")
    .select(`
      id, test_name, status, time_limit_minutes, due_date, open_date,
      show_answers_after_submission, allow_retake, review_unlocked,
      modules!module_id(module_name, section, module_number)
    `)
    .eq("id", testId)
    .single();

  if (!test) return null;

  const studentIds: string[] = assignment.student_ids ?? [];

  const { data: submissions } = await db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, submitted_at, time_spent_seconds, session_id, adaptive_track,
      users!inner(display_name, email)
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: false });

  return {
    test,
    studentIds,
    submissions: submissions ?? [],
  };
}

type RawSubmission = {
  id: string;
  student_id: string;
  status: string;
  score: number | null;
  correct_count: number | null;
  total_questions: number | null;
  percentage: number | string | null;
  submitted_at: string | null;
  time_spent_seconds: number | null;
  session_id: string | null;
  adaptive_track: string | null;
  users: { display_name: string; email: string };
};

type SubmissionAttempt = {
  key: string;
  studentName: string;
  email: string;
  status: string;
  correctCount: number;
  totalQuestions: number;
  percentage: number | null;
  scaledScore: number | null;
  timeSpentSeconds: number;
  submittedAt: string | null;
  isMultiModule: boolean;
  modules: {
    submissionId: string;
    label: string;
    correctCount: number;
    totalQuestions: number;
    percentage: number | null;
    scaledScore: number | null;
  }[];
};

// Two-module attempts produce two submission rows sharing one
// session_id; collapse them into one attempt with a combined headline
// plus per-module sub-rows. Legacy single-module rows (session_id NULL)
// stay as individual attempts.
function buildSubmissionAttempts(rows: RawSubmission[]): SubmissionAttempt[] {
  const bySession = new Map<string, RawSubmission[]>();
  const singletons: RawSubmission[] = [];
  for (const r of rows) {
    if (r.session_id) {
      const list = bySession.get(r.session_id) ?? [];
      list.push(r);
      bySession.set(r.session_id, list);
    } else {
      singletons.push(r);
    }
  }

  const attempts: SubmissionAttempt[] = singletons.map((r) => {
    const p = r.percentage != null ? Number(r.percentage) : null;
    return {
      key: r.id,
      studentName: r.users.display_name,
      email: r.users.email,
      status: r.status,
      correctCount: r.correct_count ?? 0,
      totalQuestions: r.total_questions ?? 0,
      percentage: p,
      scaledScore: p != null ? scaleSectionScore(p) : null,
      timeSpentSeconds: r.time_spent_seconds ?? 0,
      submittedAt: r.submitted_at,
      isMultiModule: false,
      modules: [],
    };
  });

  for (const [sessionId, list] of bySession) {
    if (list.length === 1) {
      const r = list[0];
      const p = r.percentage != null ? Number(r.percentage) : null;
      attempts.push({
        key: r.id,
        studentName: r.users.display_name,
        email: r.users.email,
        status: r.status,
        correctCount: r.correct_count ?? 0,
        totalQuestions: r.total_questions ?? 0,
        percentage: p,
        scaledScore: p != null ? scaleSectionScore(p) : null,
        timeSpentSeconds: r.time_spent_seconds ?? 0,
        submittedAt: r.submitted_at,
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
    const time = sorted.reduce((s, r) => s + (r.time_spent_seconds ?? 0), 0);
    const pct =
      total > 0 ? Math.round((correct / total) * 1000) / 10 : null;
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
    attempts.push({
      key: sessionId,
      studentName: sorted[0].users.display_name,
      email: sorted[0].users.email,
      status,
      correctCount: correct,
      totalQuestions: total,
      percentage: pct,
      scaledScore: pct != null ? scaleSectionScore(pct) : null,
      timeSpentSeconds: time,
      submittedAt: lastSubmittedAt,
      isMultiModule: true,
      modules: sorted.map((r) => {
        const p = r.percentage != null ? Number(r.percentage) : null;
        return {
          submissionId: r.id,
          label: MODULE_LABEL[r.adaptive_track ?? ""] ?? "Module",
          correctCount: r.correct_count ?? 0,
          totalQuestions: r.total_questions ?? 0,
          percentage: p,
          scaledScore: p != null ? scaleSectionScore(p) : null,
        };
      }),
    });
  }

  attempts.sort((a, b) => {
    if (a.submittedAt && b.submittedAt)
      return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
  });
  return attempts;
}

const statusStyles: Record<string, string> = {
  "In Progress": "bg-warm-coral/15 text-warm-coral",
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
};

function formatDuration(seconds: number | null) {
  if (!seconds) return "—";
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default async function TeacherTestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const data = await getTeacherTest(id, user.userId);
  if (!data) notFound();

  const { test, submissions } = data;
  const mod = test.modules as unknown as
    | { module_name: string; section: string; module_number: number | null }
    | null;
  // Group two-module session siblings into one attempt before computing
  // counts and averages — otherwise each multi-module attempt would
  // double-count in submission totals and skew the average percentage.
  const attempts = buildSubmissionAttempts(
    submissions as unknown as RawSubmission[],
  );
  const submitted = attempts.filter(
    (a) => a.status === "Submitted" || a.status === "Late",
  );
  const avgScore = submitted.length > 0
    ? submitted.reduce((sum, a) => sum + (a.percentage ?? 0), 0) / submitted.length
    : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <span className="text-charcoal">{test.test_name}</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-charcoal">{test.test_name}</h1>
        <p className="text-soft-mute text-sm mt-1">
          {mod
            ? <>{mod.module_name} · {mod.section}{mod.module_number ? ` M${mod.module_number}` : ""}</>
            : "Adaptive · Module 1 + Module 2 (easy/hard)"}
        </p>
      </div>

      <ReviewModeToggle
        testId={test.id}
        initialUnlocked={Boolean((test as { review_unlocked?: boolean }).review_unlocked)}
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Submitted</div>
          <div className="text-2xl font-bold text-charcoal">{submitted.length} / {attempts.length}</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Avg Score</div>
          <div className="text-2xl font-bold text-warm-amber">
            {avgScore != null ? `${avgScore.toFixed(1)}%` : "—"}
          </div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Due Date</div>
          <div className="text-charcoal font-semibold text-sm">
            {test.due_date ? formatDateTime(test.due_date) : "—"}
          </div>
        </div>
      </div>

      {/* Action links */}
      <div className="flex flex-wrap gap-3">
        <Link
          href={`/teacher/tests/${id}/results`}
          className="px-4 py-2 rounded-xl bg-warm-coral/10 border border-warm-coral/20 text-warm-coral text-sm font-medium hover:bg-warm-coral/20 transition-colors"
        >
          Full Results Dashboard
        </Link>
        <Link
          href={`/teacher/tests/${id}/analytics`}
          className="px-4 py-2 rounded-xl bg-light-bg border border-divider text-mid-gray text-sm font-medium hover:text-charcoal hover:bg-light-bg transition-colors"
        >
          Question Analytics
        </Link>
      </div>

      {/* Submissions list */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-divider">
          <h2 className="text-charcoal font-semibold">Student Submissions</h2>
        </div>
        {attempts.length === 0 ? (
          <div className="py-12 text-center text-soft-mute text-sm">No submissions yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">Student</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Score</th>
                  <th className="text-left px-5 py-3 font-medium">Correct</th>
                  <th className="text-left px-5 py-3 font-medium">Time</th>
                  <th className="text-left px-5 py-3 font-medium">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.key} className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors">
                    <td className="px-5 py-3">
                      <div className="text-charcoal font-medium">{a.studentName}</div>
                      <div className="text-soft-mute text-xs">{a.email}</div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={clsx("px-2 py-1 rounded-full text-xs font-medium", statusStyles[a.status] ?? "bg-light-bg text-mid-gray")}>
                        {a.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-mid-gray">
                      <div>
                        {a.percentage != null ? `${a.percentage.toFixed(1)}%` : "—"}
                      </div>
                      {a.scaledScore != null && (
                        <div className="text-warm-coral text-xs font-medium">
                          {a.scaledScore}/800
                        </div>
                      )}
                      {a.isMultiModule && a.modules.length > 0 && (
                        <div className="text-soft-mute text-[11px] mt-0.5 leading-snug font-normal">
                          {a.modules.map((m) => (
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
                    </td>
                    <td className="px-5 py-3 text-mid-gray">
                      <div>
                        {a.totalQuestions > 0
                          ? `${a.correctCount}/${a.totalQuestions}`
                          : "—"}
                      </div>
                      {a.isMultiModule && a.modules.length > 0 && (
                        <div className="text-soft-mute text-[11px] mt-0.5 leading-snug">
                          {a.modules.map((m) => (
                            <div key={m.submissionId}>
                              {m.label}: {m.correctCount}/{m.totalQuestions}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-mid-gray">{formatDuration(a.timeSpentSeconds)}</td>
                    <td className="px-5 py-3 text-soft-mute text-xs">
                      {a.submittedAt ? formatDateTime(a.submittedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
