import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Mail } from "lucide-react";
import { clsx } from "clsx";
import { getServiceClient } from "@/lib/supabase";
import { scaleSectionScore } from "@/lib/scoring";
import EditStudentButton from "./EditStudentButton";
import DeleteStudentButton from "./DeleteStudentButton";

interface StudentRow {
  id: string;
  email: string;
  display_name: string | null;
  account_status: string;
  created_at: string;
  clerk_user_id: string | null;
  student_profiles?:
    | { grade?: string | null; school?: string | null; campus?: string | null; class_group?: string | null; target_score?: number | null; current_level?: string | null; parent_name?: string | null; parent_email?: string | null; parent_phone?: string | null; notes?: string | null }
    | { grade?: string | null; school?: string | null; campus?: string | null; class_group?: string | null; target_score?: number | null; current_level?: string | null; parent_name?: string | null; parent_email?: string | null; parent_phone?: string | null; notes?: string | null }[]
    | null;
}

async function getStudent(id: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("users")
    .select(
      `id, email, display_name, account_status, created_at, clerk_user_id,
       student_profiles(grade, school, campus, class_group, target_score, current_level, parent_name, parent_email, parent_phone, notes)`,
    )
    .eq("id", id)
    .eq("role", "student")
    .maybeSingle<StudentRow>();
  return data ?? null;
}

async function getStudentSubmissions(studentId: string) {
  const db = getServiceClient();
  const { data } = await db
    .from("submissions")
    .select(
      `id, test_id, status, score, correct_count, total_questions, percentage,
       started_at, submitted_at, time_spent_seconds, attempt_number,
       scaled_score, scaled_section,
       tests!inner(test_name, modules!inner(module_name, section, module_number))`,
    )
    .eq("student_id", studentId)
    .order("submitted_at", { ascending: false, nullsFirst: false });
  return data ?? [];
}

const statusStyles: Record<string, string> = {
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  "In Progress": "bg-warm-coral/15 text-warm-coral",
  "Not Started": "bg-light-bg text-mid-gray",
};

function formatDuration(seconds: number | null) {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export default async function AdminStudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const student = await getStudent(id);
  if (!student) notFound();

  const submissions = await getStudentSubmissions(id);
  const profile = Array.isArray(student.student_profiles)
    ? student.student_profiles[0] ?? null
    : student.student_profiles ?? null;

  const submittedCount = submissions.filter(
    (s) => s.status === "Submitted" || s.status === "Late",
  ).length;
  const avgPct =
    submittedCount > 0
      ? submissions
          .filter((s) => s.status === "Submitted" || s.status === "Late")
          .reduce((sum, s) => sum + Number(s.percentage ?? 0), 0) / submittedCount
      : null;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/students" className="text-soft-mute hover:text-charcoal transition-colors">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-charcoal">
            {student.display_name ?? student.email}
          </h1>
          <p className="text-soft-mute text-sm flex items-center gap-1.5 mt-0.5">
            <Mail size={12} />
            {student.email}
          </p>
        </div>
        <span
          className={clsx(
            "px-3 py-1 rounded-full text-xs font-medium capitalize",
            student.account_status === "approved"
              ? "bg-warm-amber/15 text-warm-amber"
              : student.account_status === "pending"
              ? "bg-status-warning/15 text-status-warning"
              : "bg-status-error/15 text-status-error",
          )}
        >
          {student.account_status}
        </span>
        <EditStudentButton
          student={{
            id: student.id,
            display_name: student.display_name,
            email: student.email,
            grade: profile?.grade ?? null,
            school: profile?.school ?? null,
            campus: profile?.campus ?? null,
            class_group: profile?.class_group ?? null,
            target_score: profile?.target_score ?? null,
            current_level: profile?.current_level ?? null,
            parent_name: profile?.parent_name ?? null,
            parent_email: profile?.parent_email ?? null,
            parent_phone: profile?.parent_phone ?? null,
            notes: profile?.notes ?? null,
          }}
        />
        <DeleteStudentButton
          studentId={student.id}
          studentName={student.display_name ?? student.email}
          email={student.email}
        />
      </div>

      {/* Profile card */}
      <div className="bg-surface border border-divider rounded-2xl p-6 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        {[
          ["Grade", profile?.grade ?? "—"],
          ["School", profile?.school ?? "—"],
          ["Campus", profile?.campus ?? "—"],
          ["Class group", profile?.class_group ?? "—"],
          ["Target score", profile?.target_score?.toString() ?? "—"],
          ["Level", profile?.current_level ?? "—"],
          ["Parent", profile?.parent_name ?? "—"],
          ["Parent contact", profile?.parent_email ?? profile?.parent_phone ?? "—"],
        ].map(([label, value]) => (
          <div key={label}>
            <p className="text-soft-mute text-xs mb-0.5">{label}</p>
            <p className="text-charcoal font-medium">{value}</p>
          </div>
        ))}
      </div>

      {profile?.notes && (
        <div className="bg-warm-amber/10 border border-warm-amber/20 rounded-xl px-4 py-3 text-sm text-charcoal">
          <p className="text-xs uppercase tracking-wider text-warm-amber font-semibold mb-1">
            Notes
          </p>
          {profile.notes}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <p className="text-soft-mute text-xs">Tests taken</p>
          <p className="text-3xl font-bold text-charcoal mt-1">{submissions.length}</p>
        </div>
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <p className="text-soft-mute text-xs">Submitted</p>
          <p className="text-3xl font-bold text-charcoal mt-1">{submittedCount}</p>
        </div>
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <p className="text-soft-mute text-xs">Average %</p>
          <p className="text-3xl font-bold text-warm-coral mt-1">
            {avgPct != null ? `${avgPct.toFixed(1)}%` : "—"}
          </p>
        </div>
      </div>

      {/* Submissions table */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-divider">
          <h2 className="text-charcoal font-semibold">Tests taken</h2>
        </div>
        {submissions.length === 0 ? (
          <p className="py-12 text-center text-soft-mute text-sm">
            This student hasn&rsquo;t taken any tests yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-divider text-soft-mute">
                  <th className="text-left px-5 py-3 font-medium">Test</th>
                  <th className="text-left px-5 py-3 font-medium">Section</th>
                  <th className="text-left px-5 py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Score</th>
                  <th className="text-left px-5 py-3 font-medium">%</th>
                  <th className="text-left px-5 py-3 font-medium">Est. SAT</th>
                  <th className="text-left px-5 py-3 font-medium">Time</th>
                  <th className="text-left px-5 py-3 font-medium">Submitted</th>
                  <th className="text-left px-5 py-3 font-medium">Attempt</th>
                  <th className="text-left px-5 py-3 font-medium">Open</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((sub) => {
                  const testRel = sub.tests as unknown as {
                    test_name: string;
                    modules: { module_name: string; section: string; module_number: number | null };
                  };
                  return (
                    <tr
                      key={sub.id}
                      className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                    >
                      <td className="px-5 py-3">
                        <div className="font-medium text-charcoal">{testRel.test_name}</div>
                        <div className="text-soft-mute text-xs">{testRel.modules.module_name}</div>
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {testRel.modules.section}
                        {testRel.modules.module_number ? ` M${testRel.modules.module_number}` : ""}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={clsx(
                            "px-2 py-0.5 rounded-full text-xs font-medium",
                            statusStyles[sub.status] ?? "bg-light-bg text-soft-mute",
                          )}
                        >
                          {sub.status}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {sub.score != null
                          ? `${sub.score}/${sub.total_questions ?? "?"}`
                          : "—"}
                      </td>
                      <td className="px-5 py-3 text-mid-gray">
                        {sub.percentage != null ? `${Number(sub.percentage).toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-5 py-3 text-warm-coral text-sm font-medium">
                        {(() => {
                          const eff =
                            sub.scaled_score ??
                            (sub.percentage != null
                              ? scaleSectionScore(Number(sub.percentage))
                              : null);
                          return eff != null ? `${eff}/800` : "—";
                        })()}
                      </td>
                      <td className="px-5 py-3 text-soft-mute text-xs">
                        {formatDuration(sub.time_spent_seconds)}
                      </td>
                      <td className="px-5 py-3 text-soft-mute text-xs">
                        {sub.submitted_at
                          ? new Date(sub.submitted_at).toLocaleString()
                          : "—"}
                      </td>
                      <td className="px-5 py-3 text-mid-gray text-xs">{sub.attempt_number ?? 1}</td>
                      <td className="px-5 py-3">
                        <Link
                          href={`/teacher/tests/${sub.test_id}/results/${sub.id}`}
                          className="inline-flex items-center gap-1 text-xs text-warm-coral hover:underline"
                        >
                          <ExternalLink size={11} />
                          Detail
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
