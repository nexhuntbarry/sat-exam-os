import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ClipboardList } from "lucide-react";
import { clsx } from "clsx";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, getQaUserIds, onSide } from "@/lib/qa";
import {
  getStudentAssignedTestIds,
  getTeacherSubjectsForStudent,
  getTestSections,
  inSubjects,
} from "@/lib/teacher-access";
import { getServiceClient } from "@/lib/supabase";
import { formatDateTime, formatDate } from "@/lib/datetime";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import ProgressReport from "@/components/analytics/ProgressReport";
import ScoreProgressChart from "@/components/analytics/ScoreProgressChart";
import PerTestBreakdown from "@/components/analytics/PerTestBreakdown";
import { getStudentBreakdownRows, getStudentProgressOccasions } from "@/lib/student-analytics";

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
  isQa: boolean,
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
  // class_group (class_group_members check). That's the gate. We show the
  // tests this student took in the subject(s) the teacher teaches this
  // class (same subject rule as getTeacherTestAccess / the results API),
  // without requiring the teacher to be on test_assignments.teacher_ids.
  const subjects = isAdmin
    ? null
    : (await getTeacherSubjectsForStudent(db, teacherId, studentId, classGroupId)).subjects;

  const { data: subs } = await db
    .from("submissions")
    .select(
      `id, test_id, status, score, percentage, correct_count, total_questions,
       started_at, submitted_at, session_id, adaptive_track,
       tests!inner(id, test_name, due_date)`,
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
    correct_count: number | null;
    total_questions: number | null;
    started_at: string | null;
    submitted_at: string | null;
    session_id: string | null;
    adaptive_track: string | null;
    tests:
      | { id: string; test_name: string; due_date: string | null }
      | { id: string; test_name: string; due_date: string | null }[]
      | null;
  };
  const rows = (subs ?? []) as unknown as SubRow[];
  const qaTests = await getQaTestIds();
  const [sectionOf, assignedTestIds] = await Promise.all([
    getTestSections(db, Array.from(new Set(rows.map((r) => r.test_id)))),
    getStudentAssignedTestIds(db, studentId, isQa),
  ]);
  const visible = (testId: string) =>
    onSide(testId, qaTests, isQa) && inSubjects(sectionOf.get(testId) ?? null, subjects);

  // One row per attempt: two-module attempts are two submissions sharing
  // a session_id.
  const attempts = new Map<string, SubRow[]>();
  for (const r of rows) {
    if (!visible(r.test_id)) continue;
    const key = r.session_id ?? r.id;
    attempts.set(key, [...(attempts.get(key) ?? []), r]);
  }
  const submissions = Array.from(attempts.values()).map((list) => {
    const sorted = [...list].sort((a, b) =>
      (a.adaptive_track === "module_1" ? 0 : 1) - (b.adaptive_track === "module_1" ? 0 : 1),
    );
    const head = sorted[0];
    const last = sorted[sorted.length - 1];
    const t = (Array.isArray(head.tests) ? head.tests[0] : head.tests) ?? null;
    const correct = sorted.reduce((n, r) => n + (r.correct_count ?? 0), 0);
    const total = sorted.reduce((n, r) => n + (r.total_questions ?? 0), 0);
    const statuses = sorted.map((r) => r.status);
    const status = statuses.includes("In Progress")
      ? "In Progress"
      : statuses.includes("Late")
      ? "Late"
      : last.status;
    return {
      // Detail page stitches both modules via session_id from the last one.
      id: last.id,
      testId: head.test_id,
      testName: t?.test_name ?? "—",
      dueDate: t?.due_date ?? null,
      section: sectionOf.get(head.test_id) ?? null,
      status,
      percentage: sorted.length > 1
        ? total > 0 ? Math.round((correct / total) * 1000) / 10 : null
        : head.percentage == null ? null : Number(head.percentage),
      submittedAt: sorted.map((r) => r.submitted_at).filter((d): d is string => !!d).sort().pop() ?? null,
    };
  });

  // Assigned = tests assigned to the student (directly or via a class)
  // plus any they took, in the teacher's subject(s).
  const assignedSections = await getTestSections(db, Array.from(assignedTestIds));
  const assigned = new Set<string>();
  for (const id of assignedTestIds) {
    if (inSubjects(assignedSections.get(id) ?? null, subjects)) assigned.add(id);
  }
  for (const a of submissions) assigned.add(a.testId);

  return { group, student, submissions, subjects, assignedCount: assigned.size };
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
  if (
    !onSide(id, await getQaClassGroupIds(), me.isQa) ||
    !onSide(studentId, await getQaUserIds(), me.isQa)
  ) notFound();
  const data = await loadStudent(id, studentId, me.userId, me.role === "admin", me.isQa);
  if (!data) notFound();
  const { group, student, submissions, subjects, assignedCount } = data;
  // Only the subject(s) this teacher teaches the class.
  const breakdownRows = (await getStudentBreakdownRows(studentId)).filter((r) =>
    inSubjects(r.section, subjects),
  );
  const occasions = (await getStudentProgressOccasions(studentId))
    .map((o) => ({ ...o, rows: o.rows.filter((r) => inSubjects(r.section, subjects)) }))
    .filter((o) => o.rows.length > 0 && inSubjects(o.section, subjects));

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
        {occasions.length > 0 && (
          <Link href={`/report?student=${studentId}`} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-divider text-sm font-semibold text-charcoal hover:bg-light-bg transition-colors whitespace-nowrap">
            Download PDF report
          </Link>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Tests assigned" value={String(assignedCount)} />
        <Stat label="Completed" value={String(new Set(completed.map((s) => s.testId)).size)} />
        <Stat
          label="Avg score"
          value={avg == null ? "—" : `${avg.toFixed(1)}%`}
        />
      </div>

      {/* Strengths/weaknesses + progress for this student. */}
      {breakdownRows.length > 0 && (
        <ScoreBreakdown rows={breakdownRows} title="Strengths & Focus Areas" />
      )}
      {occasions.length > 1 && <ScoreProgressChart occasions={occasions} />}
      {occasions.length > 0 && (
        <ProgressReport occasions={occasions} title="Progress Over Time" subtitle={`${student.display_name ?? student.email} · across ${occasions.length} tests`} />
      )}
      {occasions.length > 0 && (
        <PerTestBreakdown occasions={occasions} title="Score Report — By Test" />
      )}

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
