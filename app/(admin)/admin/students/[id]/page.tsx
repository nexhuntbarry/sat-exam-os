import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Mail } from "lucide-react";
import { clsx } from "clsx";
import { getServiceClient } from "@/lib/supabase";
import { scaleSectionScore } from "@/lib/scoring";
import EditStudentButton from "./EditStudentButton";
import DeleteStudentButton from "./DeleteStudentButton";
import { formatDate, formatDateTime } from "@/lib/datetime";

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
       scaled_score, scaled_section, session_id, adaptive_track,
       tests!inner(test_name),
       modules!module_id(module_name, section, module_number)`,
    )
    .eq("student_id", studentId)
    .order("submitted_at", { ascending: false, nullsFirst: false });
  return data ?? [];
}

type SubmissionRow = {
  id: string;
  test_id: string;
  status: string;
  score: number | null;
  correct_count: number | null;
  total_questions: number | null;
  percentage: number | string | null;
  started_at: string | null;
  submitted_at: string | null;
  time_spent_seconds: number | null;
  attempt_number: number | null;
  scaled_score: number | null;
  scaled_section: string | null;
  session_id: string | null;
  adaptive_track: string | null;
  tests: { test_name: string };
  modules: { module_name: string; section: string; module_number: number | null } | null;
};

type SessionGroup = {
  key: string;
  testId: string;
  testName: string;
  section: string | null;
  status: string;
  correct: number;
  total: number;
  percentage: number | null;
  scaledScore: number | null;
  timeSeconds: number;
  submittedAt: string | null;
  attemptNumber: number | null;
  detailSubmissionId: string;
  isMultiModule: boolean;
};

function buildSessionGroups(rows: SubmissionRow[]): SessionGroup[] {
  // Two-module attempts (adaptive or non-adaptive) span two submission
  // rows sharing a session_id. Roll them up into one row so the admin
  // sees one entry per attempt with combined raw + combined /800. Legacy
  // single-module submissions (session_id NULL) stay as individual rows.
  const bySession = new Map<string, SubmissionRow[]>();
  const singletons: SubmissionRow[] = [];
  for (const r of rows) {
    if (r.session_id) {
      const list = bySession.get(r.session_id) ?? [];
      list.push(r);
      bySession.set(r.session_id, list);
    } else {
      singletons.push(r);
    }
  }

  const toGroup = (r: SubmissionRow): SessionGroup => ({
    key: r.id,
    testId: r.test_id,
    testName: r.tests.test_name,
    section: r.modules?.section ?? null,
    status: r.status,
    correct: r.correct_count ?? 0,
    total: r.total_questions ?? 0,
    percentage: r.percentage != null ? Number(r.percentage) : null,
    scaledScore:
      r.scaled_score ??
      (r.percentage != null ? scaleSectionScore(Number(r.percentage)) : null),
    timeSeconds: r.time_spent_seconds ?? 0,
    submittedAt: r.submitted_at,
    attemptNumber: r.attempt_number,
    detailSubmissionId: r.id,
    isMultiModule: false,
  });

  const groups: SessionGroup[] = singletons.map(toGroup);

  for (const [sessionId, list] of bySession) {
    if (list.length === 1) {
      groups.push(toGroup(list[0]));
      continue;
    }
    const sorted = [...list].sort((a, b) => {
      // module_1 first, then module_2{,_easy,_hard}. Anything else falls
      // back to started_at order to stay deterministic.
      const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
      const ra = rank(a.adaptive_track);
      const rb = rank(b.adaptive_track);
      if (ra !== rb) return ra - rb;
      return (a.started_at ?? "").localeCompare(b.started_at ?? "");
    });
    const correct = sorted.reduce((s, r) => s + (r.correct_count ?? 0), 0);
    const total = sorted.reduce((s, r) => s + (r.total_questions ?? 0), 0);
    const time = sorted.reduce((s, r) => s + (r.time_spent_seconds ?? 0), 0);
    const pct =
      total > 0 ? Math.round((correct / total) * 100 * 10) / 10 : null;
    const scaled = pct != null ? scaleSectionScore(pct) : null;
    // Headline status: if any row is still In Progress, the attempt is
    // mid-flight. Otherwise Late if any Late, else Submitted.
    const statuses = sorted.map((r) => r.status);
    const status = statuses.includes("In Progress")
      ? "In Progress"
      : statuses.includes("Late")
      ? "Late"
      : statuses[statuses.length - 1] ?? "Submitted";
    // Use the last-submitted row's timestamp + the module 1 row's
    // section label (both modules share section).
    const lastSubmittedAt =
      sorted
        .map((r) => r.submitted_at)
        .filter((d): d is string => !!d)
        .sort()
        .pop() ?? null;
    groups.push({
      key: sessionId,
      testId: sorted[0].test_id,
      testName: sorted[0].tests.test_name,
      section: sorted[0].modules?.section ?? sorted[1]?.modules?.section ?? null,
      status,
      correct,
      total,
      percentage: pct,
      scaledScore: scaled,
      timeSeconds: time,
      submittedAt: lastSubmittedAt,
      attemptNumber: sorted[0].attempt_number,
      // Detail page link routes to the Module 2 (last) submission so
      // the result view can stitch both modules via session_id.
      detailSubmissionId: sorted[sorted.length - 1].id,
      isMultiModule: true,
    });
  }

  // Sort groups by submitted_at desc, nulls last.
  groups.sort((a, b) => {
    if (a.submittedAt && b.submittedAt)
      return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
  });

  return groups;
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

  const submissions = (await getStudentSubmissions(id)) as unknown as SubmissionRow[];
  const profile = Array.isArray(student.student_profiles)
    ? student.student_profiles[0] ?? null
    : student.student_profiles ?? null;

  const groups = buildSessionGroups(submissions);
  const submittedCount = groups.filter(
    (g) => g.status === "Submitted" || g.status === "Late",
  ).length;
  const avgPct =
    submittedCount > 0
      ? groups
          .filter((g) => g.status === "Submitted" || g.status === "Late")
          .reduce((sum, g) => sum + (g.percentage ?? 0), 0) / submittedCount
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
          <p className="text-3xl font-bold text-charcoal mt-1">{groups.length}</p>
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
        {groups.length === 0 ? (
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
                {groups.map((g) => (
                  <tr
                    key={g.key}
                    className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <div className="font-medium text-charcoal">{g.testName}</div>
                      <div className="text-soft-mute text-xs">
                        {g.isMultiModule ? "Module 1 + Module 2" : "Single module"}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-mid-gray">{g.section ?? "—"}</td>
                    <td className="px-5 py-3">
                      <span
                        className={clsx(
                          "px-2 py-0.5 rounded-full text-xs font-medium",
                          statusStyles[g.status] ?? "bg-light-bg text-soft-mute",
                        )}
                      >
                        {g.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-mid-gray">
                      {g.total > 0 ? `${g.correct}/${g.total}` : "—"}
                    </td>
                    <td className="px-5 py-3 text-mid-gray">
                      {g.percentage != null ? `${g.percentage.toFixed(1)}%` : "—"}
                    </td>
                    <td className="px-5 py-3 text-warm-coral text-sm font-medium">
                      {g.scaledScore != null ? `${g.scaledScore}/800` : "—"}
                    </td>
                    <td className="px-5 py-3 text-soft-mute text-xs">
                      {formatDuration(g.timeSeconds)}
                    </td>
                    <td className="px-5 py-3 text-soft-mute text-xs">
                      {g.submittedAt ? formatDateTime(g.submittedAt) : "—"}
                    </td>
                    <td className="px-5 py-3 text-mid-gray text-xs">
                      {g.attemptNumber ?? 1}
                    </td>
                    <td className="px-5 py-3">
                      <Link
                        href={`/teacher/tests/${g.testId}/results/${g.detailSubmissionId}`}
                        className="inline-flex items-center gap-1 text-xs text-warm-coral hover:underline"
                      >
                        <ExternalLink size={11} />
                        Detail
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
