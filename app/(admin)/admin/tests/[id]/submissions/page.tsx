import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import GrantRetakeButton from "./GrantRetakeButton";
import { formatDateTimeSeconds } from "@/lib/datetime";
import { scaleSectionScore } from "@/lib/scoring";

async function getSubmissions(testId: string) {
  const db = getServiceClient();

  const { data: test } = await db
    .from("tests")
    .select("id, test_name, status")
    .eq("id", testId)
    .single();

  if (!test) return null;

  const { data: submissions } = await db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, started_at, submitted_at, time_spent_seconds, attempt_number,
      adaptive_track, module_id, session_id,
      users!inner(display_name, email),
      modules!module_id(module_name)
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: false });

  // Pending retake grants — keyed by student so the row can show
  // either a "Grant retake" button or an existing "Retake granted" pill.
  const { data: grants } = await db
    .from("test_retake_grants")
    .select("student_id")
    .eq("test_id", testId)
    .is("consumed_at", null);
  const pendingByStudent = new Set((grants ?? []).map((g) => g.student_id as string));

  return { test, submissions: submissions ?? [], pendingByStudent };
}

const TRACK_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
};


const statusStyles: Record<string, string> = {
  "In Progress": "bg-warm-coral/15 text-warm-coral",
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  Expired: "bg-status-error/15 text-status-error",
};

function formatDuration(seconds: number | null) {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export default async function TestSubmissionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const { id } = await params;
  const data = await getSubmissions(id);
  if (!data) notFound();

  const { test, submissions, pendingByStudent } = data;

  type RawSubmission = (typeof submissions)[number];

  type ModuleView = {
    submissionId: string;
    label: string;
    correctCount: number;
    totalQuestions: number;
    percentage: number | null;
    scaledScore: number | null;
  };

  type Attempt = {
    key: string;
    studentId: string;
    studentDisplayName: string;
    studentEmail: string;
    moduleHeadline: string;
    status: string;
    correctCount: number;
    totalQuestions: number;
    percentage: number | null;
    scaledScore: number | null;
    timeSpentSeconds: number;
    submittedAt: string | null;
    attemptNumber: number;
    detailSubmissionId: string;
    isMultiModule: boolean;
    modules: ModuleView[];
  };

  // Two-module attempts produce two submission rows sharing one
  // session_id; group siblings so the admin sees one row per attempt
  // with a combined headline plus per-module split. Legacy
  // single-module rows (session_id NULL) stay as their own group.
  const bySession = new Map<string, RawSubmission[]>();
  const singletons: RawSubmission[] = [];
  for (const s of submissions) {
    if (s.session_id) {
      const list = bySession.get(s.session_id) ?? [];
      list.push(s);
      bySession.set(s.session_id, list);
    } else {
      singletons.push(s);
    }
  }

  const attempts: Attempt[] = [];
  for (const s of singletons) {
    const u = s.users as unknown as { display_name: string; email: string };
    const mod = s.modules as unknown as { module_name: string } | null;
    const trackLabel = s.adaptive_track
      ? TRACK_LABEL[s.adaptive_track] ?? s.adaptive_track
      : null;
    const p = s.percentage != null ? Number(s.percentage) : null;
    attempts.push({
      key: s.id,
      studentId: s.student_id,
      studentDisplayName: u.display_name,
      studentEmail: u.email,
      moduleHeadline: trackLabel
        ? mod?.module_name
          ? `${trackLabel} · ${mod.module_name}`
          : trackLabel
        : mod?.module_name ?? "—",
      status: s.status,
      correctCount: s.correct_count ?? 0,
      totalQuestions: s.total_questions ?? 0,
      percentage: p,
      scaledScore: p != null ? scaleSectionScore(p) : null,
      timeSpentSeconds: s.time_spent_seconds ?? 0,
      submittedAt: s.submitted_at,
      attemptNumber: s.attempt_number ?? 1,
      detailSubmissionId: s.id,
      isMultiModule: false,
      modules: [],
    });
  }
  for (const [sessionId, list] of bySession) {
    if (list.length === 1) {
      const s = list[0];
      const u = s.users as unknown as { display_name: string; email: string };
      const mod = s.modules as unknown as { module_name: string } | null;
      const trackLabel = s.adaptive_track
        ? TRACK_LABEL[s.adaptive_track] ?? s.adaptive_track
        : null;
      const p = s.percentage != null ? Number(s.percentage) : null;
      attempts.push({
        key: s.id,
        studentId: s.student_id,
        studentDisplayName: u.display_name,
        studentEmail: u.email,
        moduleHeadline: trackLabel
          ? mod?.module_name
            ? `${trackLabel} · ${mod.module_name}`
            : trackLabel
          : mod?.module_name ?? "—",
        status: s.status,
        correctCount: s.correct_count ?? 0,
        totalQuestions: s.total_questions ?? 0,
        percentage: p,
        scaledScore: p != null ? scaleSectionScore(p) : null,
        timeSpentSeconds: s.time_spent_seconds ?? 0,
        submittedAt: s.submitted_at,
        attemptNumber: s.attempt_number ?? 1,
        detailSubmissionId: s.id,
        isMultiModule: false,
        modules: [],
      });
      continue;
    }
    const sorted = [...list].sort((a, b) => {
      const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
      return rank(a.adaptive_track) - rank(b.adaptive_track);
    });
    const head = sorted[0];
    const u = head.users as unknown as { display_name: string; email: string };
    const correct = sorted.reduce((acc, r) => acc + (r.correct_count ?? 0), 0);
    const total = sorted.reduce((acc, r) => acc + (r.total_questions ?? 0), 0);
    const time = sorted.reduce((acc, r) => acc + (r.time_spent_seconds ?? 0), 0);
    const pct = total > 0 ? Math.round((correct / total) * 1000) / 10 : null;
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
      studentId: head.student_id,
      studentDisplayName: u.display_name,
      studentEmail: u.email,
      moduleHeadline: "Module 1 + Module 2",
      status,
      correctCount: correct,
      totalQuestions: total,
      percentage: pct,
      scaledScore: pct != null ? scaleSectionScore(pct) : null,
      timeSpentSeconds: time,
      submittedAt: lastSubmittedAt,
      attemptNumber: head.attempt_number ?? 1,
      // Detail link routes to the Module 2 (last) submission so the
      // result view can stitch both modules via session_id.
      detailSubmissionId: sorted[sorted.length - 1].id,
      isMultiModule: true,
      modules: sorted.map((r) => {
        const p = r.percentage != null ? Number(r.percentage) : null;
        return {
          submissionId: r.id,
          label: TRACK_LABEL[r.adaptive_track ?? ""] ?? "Module",
          correctCount: r.correct_count ?? 0,
          totalQuestions: r.total_questions ?? 0,
          percentage: p,
          scaledScore: p != null ? scaleSectionScore(p) : null,
        };
      }),
    });
  }

  attempts.sort((a, b) => {
    if (a.submittedAt && b.submittedAt) return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
  });

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/admin/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/admin/tests/${test.id}`} className="hover:text-charcoal transition-colors">{test.test_name}</Link>
        <span>/</span>
        <span className="text-charcoal">Submissions</span>
      </div>

      <h1 className="text-2xl font-bold text-charcoal">Submissions — {test.test_name}</h1>

      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        {attempts.length === 0 ? (
          <div className="py-16 text-center text-soft-mute text-sm">
            No submissions yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">Student</th>
                  <th className="text-left px-5 py-3 font-medium">Module</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Score</th>
                  <th className="text-left px-5 py-3 font-medium">Correct</th>
                  <th className="text-left px-5 py-3 font-medium">Time Spent</th>
                  <th className="text-left px-5 py-3 font-medium">Submitted</th>
                  <th className="text-left px-5 py-3 font-medium">Attempt</th>
                  <th className="text-left px-5 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.key} className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors">
                    <td className="px-5 py-3">
                      <div className="text-charcoal font-medium">{a.studentDisplayName}</div>
                      <div className="text-soft-mute text-xs">{a.studentEmail}</div>
                    </td>
                    <td className="px-5 py-3">
                      <div className="text-charcoal text-xs font-medium">{a.moduleHeadline}</div>
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
                    <td className="px-5 py-3 text-mid-gray">
                      {formatDuration(a.timeSpentSeconds)}
                    </td>
                    <td className="px-5 py-3 text-soft-mute text-xs">
                      {formatDateTimeSeconds(a.submittedAt)}
                    </td>
                    <td className="px-5 py-3 text-mid-gray">#{a.attemptNumber}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        {(a.status === "Submitted" || a.status === "Late") && (
                          <Link
                            href={`/teacher/tests/${test.id}/results/${a.detailSubmissionId}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-warm-coral/10 hover:bg-warm-coral/20 text-warm-coral text-xs font-medium transition-colors"
                            title="Open per-question detail (highlights, tutor notes, answer review)"
                          >
                            View detail
                          </Link>
                        )}
                        {(a.status === "Submitted" || a.status === "Late") && (
                          <GrantRetakeButton
                            testId={test.id}
                            studentId={a.studentId}
                            studentName={a.studentDisplayName ?? a.studentEmail}
                            alreadyPending={pendingByStudent.has(a.studentId)}
                          />
                        )}
                      </div>
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
