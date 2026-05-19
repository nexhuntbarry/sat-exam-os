import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { BarChart2 } from "lucide-react";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate, formatDateTime } from "@/lib/datetime";

async function getStudentResults(studentId: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("submissions")
    .select(`
      id, test_id, status, score, correct_count, total_questions,
      percentage, submitted_at, attempt_number,
      tests!inner(test_name, modules!module_id(module_name, section))
    `)
    .eq("student_id", studentId)
    .in("status", ["Submitted", "Late"])
    .order("submitted_at", { ascending: false });
  return data ?? [];
}

export default async function StudentResultsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const results = await getStudentResults(user.userId);

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
                  const test = r.tests as unknown as { test_name: string; modules: { module_name: string; section: string } | null };
                  const pct = r.percentage != null ? Number(r.percentage) : null;
                  return (
                    <tr key={r.id} className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors">
                      <td className="px-5 py-3">
                        <div className="text-charcoal font-medium">{test.test_name}</div>
                        <div className="text-soft-mute text-xs">{test.modules?.module_name ?? "Adaptive · multi-module"}</div>
                      </td>
                      <td className="px-5 py-3 text-mid-gray">{test.modules?.section ?? "—"}</td>
                      <td className="px-5 py-3">
                        {pct != null ? (
                          <span className={clsx(
                            "font-bold",
                            pct >= 80 ? "text-warm-amber" : pct >= 60 ? "text-status-warning" : "text-status-error"
                          )}>
                            {pct.toFixed(1)}%
                          </span>
                        ) : "—"}
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {r.correct_count != null ? `${r.correct_count}/${r.total_questions}` : "—"}
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
                        {r.submitted_at ? formatDate(r.submitted_at) : "—"}
                      </td>
                      <td className="px-5 py-3">
                        <Link
                          href={`/student/tests/${r.test_id}/result?submission=${r.id}`}
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
