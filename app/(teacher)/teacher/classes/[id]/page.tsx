import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, MapPin, GraduationCap, Users } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { formatDateTime } from "@/lib/datetime";

export const dynamic = "force-dynamic";

async function loadClass(id: string, teacherId: string, isAdmin: boolean) {
  const db = getServiceClient();

  // Teacher must be assigned to this group; admin sees everything.
  if (!isAdmin) {
    const { data: link } = await db
      .from("class_group_teachers")
      .select("id")
      .eq("class_group_id", id)
      .eq("teacher_id", teacherId)
      .maybeSingle();
    if (!link) return null;
  }

  const { data: group } = await db
    .from("class_groups")
    .select("id, name, campus, grade")
    .eq("id", id)
    .maybeSingle();
  if (!group) return null;

  const { data: memberRows } = await db
    .from("class_group_members")
    .select(
      `student_id,
       users!student_id(id, email, display_name)`,
    )
    .eq("class_group_id", id);

  type MemberRow = {
    student_id: string;
    users:
      | { id: string; email: string; display_name: string | null }
      | { id: string; email: string; display_name: string | null }[]
      | null;
  };
  const students = ((memberRows ?? []) as unknown as MemberRow[])
    .map((m) => (Array.isArray(m.users) ? m.users[0] : m.users))
    .filter((u): u is NonNullable<typeof u> => Boolean(u));

  const studentIds = students.map((s) => s.id);

  // Pull every submission for these students so we can compute averages
  // and last-active per student.
  const { data: subs } = studentIds.length
    ? await db
        .from("submissions")
        .select(
          "id, student_id, status, percentage, submitted_at, test_id, tests!inner(test_name)",
        )
        .in("student_id", studentIds)
        .order("submitted_at", { ascending: false })
    : { data: [] };

  type Sub = {
    id: string;
    student_id: string;
    status: string;
    percentage: number | string | null;
    submitted_at: string | null;
    test_id: string;
    tests:
      | { test_name: string }
      | { test_name: string }[]
      | null;
  };
  const subRows = (subs ?? []) as unknown as Sub[];

  const perStudent: Record<
    string,
    {
      total: number;
      completed: number;
      scores: number[];
      latest: { test_name: string; submitted_at: string | null; percentage: number | null } | null;
    }
  > = {};
  for (const s of subRows) {
    const slot = perStudent[s.student_id] ?? {
      total: 0,
      completed: 0,
      scores: [] as number[],
      latest: null as
        | { test_name: string; submitted_at: string | null; percentage: number | null }
        | null,
    };
    slot.total++;
    const isDone = s.status === "Submitted" || s.status === "Late";
    if (isDone) {
      slot.completed++;
      if (s.percentage != null) slot.scores.push(Number(s.percentage));
    }
    if (!slot.latest && isDone) {
      const t = (Array.isArray(s.tests) ? s.tests[0] : s.tests) as
        | { test_name: string }
        | null;
      slot.latest = {
        test_name: t?.test_name ?? "—",
        submitted_at: s.submitted_at,
        percentage: s.percentage == null ? null : Number(s.percentage),
      };
    }
    perStudent[s.student_id] = slot;
  }

  return { group, students, perStudent };
}

export default async function TeacherClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/sign-in");
  if (me.role !== "teacher" && me.role !== "admin") redirect("/dashboard");

  const { id } = await params;
  const data = await loadClass(id, me.userId, me.role === "admin");
  if (!data) notFound();
  const { group, students, perStudent } = data;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/teacher/classes" className="text-soft-mute hover:text-charcoal">
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-charcoal">{group.name}</h1>
          <div className="mt-1 flex flex-wrap gap-3 text-soft-mute text-xs">
            {group.campus && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={11} />
                {group.campus}
              </span>
            )}
            {group.grade && (
              <span className="inline-flex items-center gap-1">
                <GraduationCap size={11} />
                {group.grade}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Users size={11} />
              {students.length} {students.length === 1 ? "student" : "students"}
            </span>
          </div>
        </div>
      </div>

      <section className="bg-surface border border-divider rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-divider">
          <h2 className="text-charcoal font-semibold">Roster</h2>
        </div>
        {students.length === 0 ? (
          <div className="py-12 text-center text-soft-mute text-sm">
            No students in this class yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-divider text-soft-mute">
                <th className="text-left px-5 py-3 font-medium">Student</th>
                <th className="text-left px-5 py-3 font-medium">Tests assigned</th>
                <th className="text-left px-5 py-3 font-medium">Completed</th>
                <th className="text-left px-5 py-3 font-medium">Avg score</th>
                <th className="text-left px-5 py-3 font-medium">Latest</th>
                <th className="text-left px-5 py-3 font-medium">History</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => {
                const stats = perStudent[s.id] ?? { total: 0, completed: 0, scores: [], latest: null };
                const avg =
                  stats.scores.length > 0
                    ? stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length
                    : null;
                return (
                  <tr
                    key={s.id}
                    className="border-b border-divider last:border-0 hover:bg-light-bg/60 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <div className="text-charcoal font-medium">
                        {s.display_name ?? s.email}
                      </div>
                      {s.display_name && (
                        <div className="text-soft-mute text-xs">{s.email}</div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-mid-gray text-xs">{stats.total}</td>
                    <td className="px-5 py-3 text-mid-gray text-xs">{stats.completed}</td>
                    <td className="px-5 py-3 text-xs font-medium">
                      {avg == null ? (
                        <span className="text-soft-mute">—</span>
                      ) : (
                        <span
                          className={
                            avg < 60
                              ? "text-status-error"
                              : avg < 80
                              ? "text-warm-amber"
                              : "text-status-success"
                          }
                        >
                          {avg.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-mid-gray text-xs">
                      {stats.latest ? (
                        <div className="space-y-0.5">
                          <div className="text-charcoal truncate max-w-[14rem]">
                            {stats.latest.test_name}
                          </div>
                          <div>
                            {stats.latest.percentage != null
                              ? `${stats.latest.percentage.toFixed(0)}%`
                              : "—"}
                            {stats.latest.submitted_at
                              ? ` · ${formatDateTime(stats.latest.submitted_at)}`
                              : ""}
                          </div>
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Link
                        href={`/teacher/classes/${group.id}/students/${s.id}`}
                        className="text-warm-coral text-xs font-medium hover:underline"
                      >
                        View tests
                      </Link>
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
