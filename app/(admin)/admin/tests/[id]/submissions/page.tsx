import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";

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
      users!inner(display_name, email)
    `)
    .eq("test_id", testId)
    .order("submitted_at", { ascending: false });

  return { test, submissions: submissions ?? [] };
}

const statusStyles: Record<string, string> = {
  "In Progress": "bg-electric-blue/15 text-electric-blue",
  Submitted: "bg-lime-green/15 text-lime-green",
  Late: "bg-amber/15 text-amber",
  Expired: "bg-rose/15 text-rose",
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

  const { test, submissions } = data;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-gray/50 text-sm">
        <Link href="/admin/tests" className="hover:text-soft-gray transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/admin/tests/${test.id}`} className="hover:text-soft-gray transition-colors">{test.test_name}</Link>
        <span>/</span>
        <span className="text-white">Submissions</span>
      </div>

      <h1 className="text-2xl font-bold text-white">Submissions — {test.test_name}</h1>

      <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
        {submissions.length === 0 ? (
          <div className="py-16 text-center text-soft-gray/40 text-sm">
            No submissions yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-soft-gray/50">
                  <th className="text-left px-5 py-3 font-medium">Student</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Score</th>
                  <th className="text-left px-5 py-3 font-medium">Correct</th>
                  <th className="text-left px-5 py-3 font-medium">Time Spent</th>
                  <th className="text-left px-5 py-3 font-medium">Submitted</th>
                  <th className="text-left px-5 py-3 font-medium">Attempt</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((sub) => {
                  const u = sub.users as unknown as { display_name: string; email: string };
                  return (
                    <tr key={sub.id} className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
                      <td className="px-5 py-3">
                        <div className="text-white font-medium">{u.display_name}</div>
                        <div className="text-soft-gray/40 text-xs">{u.email}</div>
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx("px-2 py-1 rounded-full text-xs font-medium", statusStyles[sub.status] ?? "bg-white/10 text-soft-gray/60")}>
                          {sub.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {sub.percentage != null ? `${Number(sub.percentage).toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {sub.correct_count != null ? `${sub.correct_count}/${sub.total_questions}` : "—"}
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {formatDuration(sub.time_spent_seconds)}
                      </td>
                      <td className="px-5 py-3 text-soft-gray/50 text-xs">
                        {sub.submitted_at ? new Date(sub.submitted_at).toLocaleString() : "—"}
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">#{sub.attempt_number}</td>
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
