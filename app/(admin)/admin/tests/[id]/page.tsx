import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import TestDetailActions from "./TestDetailActions";

async function getTest(id: string) {
  const db = getServiceClient();

  const { data: test, error } = await db
    .from("tests")
    .select(`
      id, test_name, module_id, time_limit_minutes, open_date, due_date,
      show_answers_after_submission, allow_retake, status, created_at, updated_at,
      modules!inner(module_name, section, module_number, source_name)
    `)
    .eq("id", id)
    .single();

  if (error || !test) return null;

  const [{ data: assignment }, { data: submissions }] = await Promise.all([
    db.from("test_assignments").select("teacher_ids, student_ids, class_group_ids").eq("test_id", id).single(),
    db.from("submissions").select("id, status, score, percentage, student_id, submitted_at").eq("test_id", id),
  ]);

  // Get teacher names
  const teacherIds: string[] = assignment?.teacher_ids ?? [];
  const studentIds: string[] = assignment?.student_ids ?? [];
  const classGroupIds: string[] = assignment?.class_group_ids ?? [];

  const [{ data: teachers }, { data: classGroups }] = await Promise.all([
    teacherIds.length > 0
      ? db.from("users").select("id, display_name, email").in("id", teacherIds)
      : Promise.resolve({ data: [] }),
    classGroupIds.length > 0
      ? db.from("class_groups").select("id, name").in("id", classGroupIds)
      : Promise.resolve({ data: [] }),
  ]);

  const submittedSubs = (submissions ?? []).filter((s) => s.status === "Submitted" || s.status === "Late");
  const avgScore = submittedSubs.length > 0
    ? submittedSubs.reduce((sum, s) => sum + (Number(s.percentage) || 0), 0) / submittedSubs.length
    : null;

  return {
    ...test,
    assignment: {
      teacherIds,
      studentIds,
      classGroupIds,
      teachers: teachers ?? [],
      classGroups: classGroups ?? [],
    },
    stats: {
      total: (submissions ?? []).length,
      submitted: submittedSubs.length,
      avgScore,
    },
  };
}

const statusStyles: Record<string, string> = {
  Draft: "bg-light-bg text-mid-gray",
  Published: "bg-warm-amber/15 text-warm-amber",
  Closed: "bg-status-error/15 text-status-error",
};

export default async function TestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const { id } = await params;
  const test = await getTest(id);
  if (!test) notFound();

  const mod = test.modules as unknown as { module_name: string; section: string; module_number: number | null; source_name: string | null };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/admin/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <span className="text-charcoal">{test.test_name}</span>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-charcoal">{test.test_name}</h1>
            <span className={clsx("px-2.5 py-1 rounded-full text-xs font-semibold", statusStyles[test.status] ?? "bg-light-bg text-mid-gray")}>
              {test.status}
            </span>
          </div>
          <p className="text-soft-mute text-sm">
            {mod.module_name} · {mod.section}{mod.module_number ? ` M${mod.module_number}` : ""}
            {mod.source_name ? ` · ${mod.source_name}` : ""}
          </p>
        </div>
        <TestDetailActions testId={test.id} status={test.status} />
      </div>

      {/* Config summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Time Limit", value: test.time_limit_minutes ? `${test.time_limit_minutes} min` : "—" },
          { label: "Open Date", value: test.open_date ? new Date(test.open_date).toLocaleString() : "—" },
          { label: "Due Date", value: test.due_date ? new Date(test.due_date).toLocaleString() : "—" },
          { label: "Allow Retake", value: test.allow_retake ? "Yes" : "No" },
          { label: "Show Answers", value: test.show_answers_after_submission ? "Yes" : "No" },
          { label: "Teachers", value: String(test.assignment.teacherIds.length) },
          { label: "Students", value: String(test.assignment.studentIds.length) },
          { label: "Class Groups", value: String(test.assignment.classGroupIds.length) },
        ].map(({ label, value }) => (
          <div key={label} className="bg-surface border border-divider rounded-xl p-4">
            <div className="text-soft-mute text-xs mb-1">{label}</div>
            <div className="text-charcoal font-semibold text-sm">{value}</div>
          </div>
        ))}
      </div>

      {/* Submission stats */}
      <div className="bg-surface border border-divider rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-charcoal font-semibold">Submissions</h2>
          <Link href={`/admin/tests/${test.id}/submissions`} className="text-warm-coral text-sm hover:underline">
            View all submissions →
          </Link>
        </div>
        <div className="flex gap-6">
          <div>
            <div className="text-2xl font-bold text-charcoal">{test.stats.submitted}</div>
            <div className="text-soft-mute text-xs">Submitted</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-charcoal">{test.stats.total}</div>
            <div className="text-soft-mute text-xs">Total</div>
          </div>
          {test.stats.avgScore !== null && (
            <div>
              <div className="text-2xl font-bold text-warm-amber">{test.stats.avgScore.toFixed(1)}%</div>
              <div className="text-soft-mute text-xs">Avg Score</div>
            </div>
          )}
        </div>
      </div>

      {/* Assignment details */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-surface border border-divider rounded-xl p-4 space-y-2">
          <h3 className="text-soft-mute text-xs font-medium uppercase tracking-wider">Teachers</h3>
          {test.assignment.teachers.length === 0 ? (
            <p className="text-soft-mute text-sm">None assigned</p>
          ) : test.assignment.teachers.map((t: { id: string; display_name: string; email: string }) => (
            <div key={t.id} className="text-charcoal text-sm">{t.display_name}</div>
          ))}
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 space-y-2">
          <h3 className="text-soft-mute text-xs font-medium uppercase tracking-wider">Class Groups</h3>
          {test.assignment.classGroups.length === 0 ? (
            <p className="text-soft-mute text-sm">None assigned</p>
          ) : test.assignment.classGroups.map((cg: { id: string; name: string }) => (
            <div key={cg.id} className="text-charcoal text-sm">{cg.name}</div>
          ))}
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 space-y-2">
          <h3 className="text-soft-mute text-xs font-medium uppercase tracking-wider">Individual Students</h3>
          <p className="text-soft-mute text-sm">{test.assignment.studentIds.length} student(s)</p>
        </div>
      </div>
    </div>
  );
}
