import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { clsx } from "clsx";
import PageIntro from "@/components/shared/PageIntro";
import { formatDate, formatDateTime } from "@/lib/datetime";

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
      .select("test_id, id, status, score, percentage, submitted_at, attempt_number")
      .eq("student_id", studentId)
      .in("test_id", testIds)
      .order("attempt_number", { ascending: false }),
  ]);

  const subMap: Record<string, { id: string; status: string; score: number | null; percentage: number | null }> = {};
  for (const s of submissions ?? []) {
    if (!subMap[s.test_id]) {
      subMap[s.test_id] = {
        id: s.id,
        status: s.status,
        score: s.score,
        percentage: s.percentage,
      };
    }
  }

  return (tests ?? []).map((t) => {
    const sub = subMap[t.id];
    let testStatus = "Not Started";
    if (sub) {
      if (sub.status === "In Progress") testStatus = "In Progress";
      else if (sub.status === "Submitted" || sub.status === "Late") testStatus = "Submitted";
    }
    return { ...t, submission: sub ?? null, testStatus };
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
                        {test.submission?.percentage != null
                          ? `${Number(test.submission.percentage).toFixed(1)}%`
                          : "—"}
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
