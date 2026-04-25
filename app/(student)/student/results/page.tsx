import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { redirect } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { BarChart2 } from "lucide-react";

async function getStudentResults(studentId: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("submissions")
    .select(`
      id, test_id, status, score, correct_count, total_questions,
      percentage, submitted_at, attempt_number,
      tests!inner(test_name, modules!inner(module_name, section))
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
      <h1 className="text-2xl font-bold text-white">My Results</h1>

      <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
        {results.length === 0 ? (
          <div className="py-16 text-center space-y-3">
            <BarChart2 size={40} className="text-soft-gray/20 mx-auto" />
            <p className="text-soft-gray/40 text-sm">No completed tests yet.</p>
            <Link
              href="/student/tests"
              className="inline-block mt-2 px-4 py-2 rounded-xl bg-electric-blue/15 text-electric-blue text-sm hover:bg-electric-blue/25 transition-colors"
            >
              Go to My Tests
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-soft-gray/50">
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
                  const test = r.tests as unknown as { test_name: string; modules: { module_name: string; section: string } };
                  const pct = r.percentage != null ? Number(r.percentage) : null;
                  return (
                    <tr key={r.id} className="border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
                      <td className="px-5 py-3">
                        <div className="text-white font-medium">{test.test_name}</div>
                        <div className="text-soft-gray/40 text-xs">{test.modules.module_name}</div>
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">{test.modules.section}</td>
                      <td className="px-5 py-3">
                        {pct != null ? (
                          <span className={clsx(
                            "font-bold",
                            pct >= 80 ? "text-lime-green" : pct >= 60 ? "text-amber" : "text-rose"
                          )}>
                            {pct.toFixed(1)}%
                          </span>
                        ) : "—"}
                      </td>
                      <td className="px-5 py-3 text-soft-gray/70">
                        {r.correct_count != null ? `${r.correct_count}/${r.total_questions}` : "—"}
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx(
                          "px-2 py-1 rounded-full text-xs font-medium",
                          r.status === "Submitted" ? "bg-lime-green/15 text-lime-green" : "bg-amber/15 text-amber"
                        )}>
                          {r.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-soft-gray/50 text-xs">
                        {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-5 py-3">
                        <Link
                          href={`/student/tests/${r.test_id}/result?submission=${r.id}`}
                          className="px-3 py-1.5 rounded-lg bg-white/8 text-soft-gray/70 hover:text-white hover:bg-white/12 text-xs font-medium transition-colors"
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
