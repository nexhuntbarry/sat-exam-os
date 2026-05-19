import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ClipboardList } from "lucide-react";
import { clsx } from "clsx";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { formatDateTime, formatDate } from "@/lib/datetime";

export const dynamic = "force-dynamic";

const statusCls: Record<string, string> = {
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  "In Progress": "bg-warm-coral/15 text-warm-coral",
  Expired: "bg-light-bg text-mid-gray",
};

async function loadStudent(
  classGroupId: string,
  studentId: string,
  teacherId: string,
  isAdmin: boolean,
) {
  const db = getServiceClient();

  // Authz: teacher must own this class_group; admin bypass.
  if (!isAdmin) {
    const { data: link } = await db
      .from("class_group_teachers")
      .select("id")
      .eq("class_group_id", classGroupId)
      .eq("teacher_id", teacherId)
      .maybeSingle();
    if (!link) return null;
  }

  // Student must be a member of this class_group.
  const { data: membership } = await db
    .from("class_group_members")
    .select("id")
    .eq("class_group_id", classGroupId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (!membership) return null;

  const [{ data: group }, { data: student }] = await Promise.all([
    db.from("class_groups").select("id, name, campus, grade").eq("id", classGroupId).maybeSingle(),
    db.from("users").select("id, email, display_name").eq("id", studentId).maybeSingle(),
  ]);
  if (!group || !student) return null;

  // Authz model: teacher already proved ownership of this class_group
  // above (class_group_teachers check) AND the student belongs to this
  // class_group (class_group_members check). That's the gate. Showing
  // every test this student has taken is fine — the teacher is
  // legitimately responsible for the student's progress.
  //
  // We do NOT additionally require the teacher to be on
  // test_assignments.teacher_ids — admins routinely create tests on
  // behalf of teachers without adding the teacher to that JSON array,
  // and the screen would render empty for the most common workflow.
  // The student-scope check is what enforces the "own students only"
  // requirement, not the test-assignment check.
  void teacherId;
  void isAdmin;
  const { data: subs } = await db
    .from("submissions")
    .select(
      `id, test_id, status, score, percentage, started_at, submitted_at,
       tests!inner(id, test_name, due_date, modules!module_id(section))`,
    )
    .eq("student_id", studentId)
    .order("submitted_at", { ascending: false, nullsFirst: false })
    .order("started_at", { ascending: false });

  type SubRow = {
    id: string;
    test_id: string;
    status: string;
    score: number | string | null;
    percentage: number | string | null;
    started_at: string | null;
    submitted_at: string | null;
    tests:
      | {
          id: string;
          test_name: string;
          due_date: string | null;
          modules: { section: string } | { section: string }[] | null;
        }
      | {
          id: string;
          test_name: string;
          due_date: string | null;
          modules: { section: string } | { section: string }[] | null;
        }[]
      | null;
  };
  const submissions = ((subs ?? []) as unknown as SubRow[]).map((s) => {
    const t = (Array.isArray(s.tests) ? s.tests[0] : s.tests) as
      | {
          id: string;
          test_name: string;
          due_date: string | null;
          modules: { section: string } | { section: string }[] | null;
        }
      | null;
    const m = t
      ? ((Array.isArray(t.modules) ? t.modules[0] : t.modules) as
          | { section: string }
          | null)
      : null;
    return {
      id: s.id,
      testId: s.test_id,
      testName: t?.test_name ?? "—",
      dueDate: t?.due_date ?? null,
      section: m?.section ?? null,
      status: s.status,
      score: s.score == null ? null : Number(s.score),
      percentage: s.percentage == null ? null : Number(s.percentage),
      submittedAt: s.submitted_at,
      startedAt: s.started_at,
    };
  });

  return { group, student, submissions };
}

export default async function TeacherStudentResultsPage({
  params,
}: {
  params: Promise<{ id: string; studentId: string }>;
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/sign-in");
  if (me.role !== "teacher" && me.role !== "admin") redirect("/dashboard");

  const { id, studentId } = await params;
  const data = await loadStudent(id, studentId, me.userId, me.role === "admin");
  if (!data) notFound();
  const { group, student, submissions } = data;

  const completed = submissions.filter(
    (s) => s.status === "Submitted" || s.status === "Late",
  );
  const avg =
    completed.length > 0 && completed.every((s) => s.percentage != null)
      ? completed.reduce((a, b) => a + (b.percentage ?? 0), 0) / completed.length
      : completed.length > 0
      ? completed
          .filter((s) => s.percentage != null)
          .reduce((a, b) => a + (b.percentage ?? 0), 0) /
        Math.max(1, completed.filter((s) => s.percentage != null).length)
      : null;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/teacher/classes/${id}`}
          className="text-soft-mute hover:text-charcoal"
        >
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <div className="text-soft-mute text-xs">
            <Link href={`/teacher/classes/${id}`} className="hover:text-charcoal">
              {group.name}
            </Link>
          </div>
          <h1 className="text-2xl font-bold text-charcoal">
            {student.display_name ?? student.email}
          </h1>
          <p className="text-soft-mute text-xs">{student.email}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Tests assigned" value={String(submissions.length)} />
        <Stat label="Completed" value={String(completed.length)} />
        <Stat
          label="Avg score"
          value={avg == null ? "—" : `${avg.toFixed(1)}%`}
        />
      </div>

      <section className="bg-surface border border-divider rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-divider">
          <h2 className="text-charcoal font-semibold flex items-center gap-2">
            <ClipboardList size={15} />
            Test history
          </h2>
        </div>
        {submissions.length === 0 ? (
          <div className="py-12 text-center text-soft-mute text-sm">
            No tests assigned to this student under your account yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-divider text-soft-mute">
                <th className="text-left px-5 py-3 font-medium">Test</th>
                <th className="text-left px-5 py-3 font-medium">Section</th>
                <th className="text-left px-5 py-3 font-medium">Due</th>
                <th className="text-left px-5 py-3 font-medium">Submitted</th>
                <th className="text-left px-5 py-3 font-medium">Status</th>
                <th className="text-left px-5 py-3 font-medium">Score</th>
                <th className="text-left px-5 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => {
                const isDone = s.status === "Submitted" || s.status === "Late";
                return (
                  <tr
                    key={s.id}
                    className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <div className="text-charcoal font-medium">{s.testName}</div>
                    </td>
                    <td className="px-5 py-3 text-mid-gray text-xs">{s.section ?? "—"}</td>
                    <td className="px-5 py-3 text-mid-gray text-xs">
                      {s.dueDate ? formatDate(s.dueDate) : "—"}
                    </td>
                    <td className="px-5 py-3 text-mid-gray text-xs">
                      {s.submittedAt ? formatDateTime(s.submittedAt) : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={clsx(
                          "px-2 py-0.5 rounded-full text-xs font-medium",
                          statusCls[s.status] ?? "bg-light-bg text-mid-gray",
                        )}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs font-medium">
                      {s.percentage == null ? (
                        <span className="text-soft-mute">—</span>
                      ) : (
                        <span
                          className={
                            s.percentage < 60
                              ? "text-status-error"
                              : s.percentage < 80
                              ? "text-warm-amber"
                              : "text-status-success"
                          }
                        >
                          {s.percentage.toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {isDone ? (
                        <Link
                          href={`/teacher/tests/${s.testId}/results/${s.id}`}
                          className="text-warm-coral text-xs font-medium hover:underline"
                        >
                          View detail
                        </Link>
                      ) : (
                        <span className="text-soft-mute text-xs">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface border border-divider rounded-2xl p-4">
      <p className="text-soft-mute text-xs">{label}</p>
      <p className="text-2xl font-bold text-charcoal mt-1">{value}</p>
    </div>
  );
}
