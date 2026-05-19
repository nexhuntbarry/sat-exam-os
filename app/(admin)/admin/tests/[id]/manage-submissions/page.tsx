import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/datetime";
import SubmissionRowActions from "./SubmissionRowActions";

export const dynamic = "force-dynamic";

interface SubRow {
  id: string;
  student_id: string;
  status: string;
  score: number | null;
  percentage: number | string | null;
  started_at: string;
  submitted_at: string | null;
  attempt_number: number;
  adaptive_track: string | null;
  module_id: string | null;
  session_id: string | null;
  users:
    | { display_name: string | null; email: string }
    | { display_name: string | null; email: string }[]
    | null;
}

export default async function ManageSubmissionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");
  const { id: testId } = await params;

  const db = getServiceClient();
  const { data: test } = await db
    .from("tests")
    .select("id, test_name, status")
    .eq("id", testId)
    .maybeSingle();
  if (!test) notFound();

  const { data, error } = await db
    .from("submissions")
    .select(
      `id, student_id, status, score, percentage, started_at, submitted_at,
       attempt_number, adaptive_track, module_id, session_id,
       users!inner(display_name, email)`,
    )
    .eq("test_id", testId)
    .order("started_at", { ascending: false });
  if (error) {
    console.error("[admin/tests/manage-submissions]", error);
  }
  const rows = (data ?? []) as unknown as SubRow[];

  // Group by attempt: session_id when present, else submission.id itself.
  // Same session = both Module 1 + Module 2 of a single attempt.
  const groups = new Map<
    string,
    { studentName: string; email: string; submissions: SubRow[] }
  >();
  for (const r of rows) {
    const key = r.session_id ?? r.id;
    const u = (Array.isArray(r.users) ? r.users[0] : r.users) as
      | { display_name: string | null; email: string }
      | null;
    if (!groups.has(key)) {
      groups.set(key, {
        studentName: u?.display_name ?? u?.email ?? "—",
        email: u?.email ?? "",
        submissions: [],
      });
    }
    groups.get(key)!.submissions.push(r);
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3 text-soft-mute text-sm">
        <Link href={`/admin/tests/${testId}`} className="hover:text-charcoal inline-flex items-center gap-1">
          <ArrowLeft size={14} /> Back to test
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Manage submissions</h1>
        <p className="text-soft-mute text-sm mt-1">
          {test.test_name} · {rows.length} submission{rows.length === 1 ? "" : "s"} across {groups.size} attempt
          {groups.size === 1 ? "" : "s"}
        </p>
      </div>

      <div className="bg-warm-amber/10 border border-warm-amber/30 rounded-xl px-4 py-3 text-sm text-charcoal">
        <p className="font-semibold">Admin tools</p>
        <ul className="text-mid-gray text-xs mt-1 space-y-0.5 list-disc list-inside">
          <li><strong>Reset</strong>: wipes this submission&apos;s answers + resets timer to now. Student can keep trying.</li>
          <li><strong>Force submit</strong>: grades whatever answers are saved and closes the submission (for stuck students).</li>
          <li><strong>Delete attempt</strong>: removes the entire attempt (both Module 1 + Module 2 if applicable). Student starts fresh on next open.</li>
        </ul>
      </div>

      {groups.size === 0 ? (
        <div className="bg-surface border border-divider rounded-2xl py-12 text-center text-soft-mute text-sm">
          No submissions yet.
        </div>
      ) : (
        <div className="space-y-4">
          {Array.from(groups.entries()).map(([key, group]) => (
            <div
              key={key}
              className="bg-surface border border-divider rounded-2xl overflow-hidden"
            >
              <div className="px-5 py-3 border-b border-divider flex items-center justify-between">
                <div>
                  <p className="text-charcoal font-semibold">{group.studentName}</p>
                  <p className="text-soft-mute text-xs">{group.email}</p>
                </div>
                <SubmissionRowActions
                  attemptKey={key}
                  submissionIds={group.submissions.map((s) => s.id)}
                  mode="attempt"
                />
              </div>
              <table className="w-full text-sm">
                <thead className="bg-light-bg text-soft-mute text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">Module</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium">Score</th>
                    <th className="text-left px-4 py-2 font-medium">Started</th>
                    <th className="text-left px-4 py-2 font-medium">Submitted</th>
                    <th className="text-left px-4 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {group.submissions
                    .slice()
                    .sort((a, b) =>
                      (a.adaptive_track ?? "").localeCompare(b.adaptive_track ?? ""),
                    )
                    .map((s) => {
                      const moduleLabel =
                        s.adaptive_track === "module_1"
                          ? "Module 1"
                          : s.adaptive_track === "module_2"
                            ? "Module 2"
                            : s.adaptive_track === "module_2_easy"
                              ? "Module 2 · Easy"
                              : s.adaptive_track === "module_2_hard"
                                ? "Module 2 · Hard"
                                : "Single";
                      return (
                        <tr key={s.id} className="border-t border-divider">
                          <td className="px-4 py-2 text-charcoal font-medium">
                            {moduleLabel}
                          </td>
                          <td className="px-4 py-2 text-mid-gray">{s.status}</td>
                          <td className="px-4 py-2 text-mid-gray">
                            {s.percentage != null
                              ? `${Number(s.percentage).toFixed(0)}%`
                              : "—"}
                          </td>
                          <td className="px-4 py-2 text-mid-gray text-xs">
                            {formatDateTime(s.started_at)}
                          </td>
                          <td className="px-4 py-2 text-mid-gray text-xs">
                            {s.submitted_at ? formatDateTime(s.submitted_at) : "—"}
                          </td>
                          <td className="px-4 py-2">
                            <SubmissionRowActions
                              attemptKey={s.id}
                              submissionIds={[s.id]}
                              mode="single"
                              isInProgress={s.status === "In Progress"}
                            />
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
