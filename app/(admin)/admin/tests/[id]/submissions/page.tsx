import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import GrantRetakeButton from "./GrantRetakeButton";
import { formatDateTimeSeconds } from "@/lib/datetime";

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
        {submissions.length === 0 ? (
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
                {submissions.map((sub) => {
                  const u = sub.users as unknown as { display_name: string; email: string };
                  const mod = sub.modules as unknown as { module_name: string } | null;
                  const trackLabel = sub.adaptive_track
                    ? TRACK_LABEL[sub.adaptive_track] ?? sub.adaptive_track
                    : null;
                  return (
                    <tr key={sub.id} className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors">
                      <td className="px-5 py-3">
                        <div className="text-charcoal font-medium">{u.display_name}</div>
                        <div className="text-soft-mute text-xs">{u.email}</div>
                      </td>
                      <td className="px-5 py-3">
                        {trackLabel ? (
                          <>
                            <div className="text-charcoal text-xs font-medium">{trackLabel}</div>
                            {mod?.module_name && (
                              <div className="text-soft-mute text-[11px]">{mod.module_name}</div>
                            )}
                          </>
                        ) : mod?.module_name ? (
                          <div className="text-charcoal text-xs">{mod.module_name}</div>
                        ) : (
                          <span className="text-soft-mute text-xs">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx("px-2 py-1 rounded-full text-xs font-medium", statusStyles[sub.status] ?? "bg-light-bg text-mid-gray")}>
                          {sub.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {sub.percentage != null ? `${Number(sub.percentage).toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {sub.correct_count != null ? `${sub.correct_count}/${sub.total_questions}` : "—"}
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {formatDuration(sub.time_spent_seconds)}
                      </td>
                      <td className="px-5 py-3 text-soft-mute text-xs">
                        {formatDateTimeSeconds(sub.submitted_at)}
                      </td>
                      <td className="px-5 py-3 text-mid-gray">#{sub.attempt_number}</td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          {(sub.status === "Submitted" || sub.status === "Late") && (
                            <Link
                              href={`/teacher/tests/${test.id}/results/${sub.id}`}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-warm-coral/10 hover:bg-warm-coral/20 text-warm-coral text-xs font-medium transition-colors"
                              title="Open per-question detail (highlights, tutor notes, answer review)"
                            >
                              View detail
                            </Link>
                          )}
                          {(sub.status === "Submitted" || sub.status === "Late") && (
                            <GrantRetakeButton
                              testId={test.id}
                              studentId={sub.student_id}
                              studentName={u.display_name ?? u.email}
                              alreadyPending={pendingByStudent.has(sub.student_id)}
                            />
                          )}
                        </div>
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
