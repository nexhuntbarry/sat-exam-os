import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Users } from "lucide-react";
import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { formatDate, formatShortDate } from "@/lib/datetime";
import { isQaEmail } from "@/lib/qa";
import {
  DataRow,
  DataTable,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  HeadRow,
  Td,
  Th,
  TwoLineCell,
} from "@/components/ui/data-table";
import { DetailHeader, StatCards } from "@/components/ui/DetailHeader";
import { StatusBadge, studentStatusLabel } from "@/components/ui/StatusBadge";

async function getTeacherDetail(teacherId: string) {
  const db = getServiceClient();

  const { data: teacher } = await db
    .from("users")
    .select(
      `id, email, display_name, account_status, created_at, can_review_questions,
       teacher_profiles!teacher_profiles_user_id_fkey(bio, specialty)`,
    )
    .eq("id", teacherId)
    .eq("role", "teacher")
    .maybeSingle();

  if (!teacher) return null;

  // Class groups this teacher is assigned to (persistent assignment).
  const { data: classLinks } = await db
    .from("class_group_teachers")
    .select("class_group_id")
    .eq("teacher_id", teacherId);

  const classGroupIds = (classLinks ?? []).map((l) => l.class_group_id);

  let classes: Array<{
    id: string;
    name: string;
    campus: string | null;
    grade: string | null;
    students: Array<{
      id: string;
      display_name: string | null;
      email: string;
      grade: string | null;
      class_group: string | null;
    }>;
  }> = [];

  if (classGroupIds.length > 0) {
    const { data: groups } = await db
      .from("class_groups")
      .select("id, name, campus, grade")
      .in("id", classGroupIds)
      .order("name", { ascending: true });

    const { data: members } = await db
      .from("class_group_members")
      .select("class_group_id, student_id")
      .in("class_group_id", classGroupIds);

    const studentIds = [...new Set((members ?? []).map((m) => m.student_id))];
    let studentsById: Record<string, {
      id: string;
      display_name: string | null;
      email: string;
      grade: string | null;
      class_group: string | null;
    }> = {};

    if (studentIds.length > 0) {
      const { data: studentRows } = await db
        .from("users")
        .select(
          `id, display_name, email,
           student_profiles!student_profiles_user_id_fkey(grade, class_group)`,
        )
        .in("id", studentIds);
      studentsById = Object.fromEntries(
        (studentRows ?? []).map((s) => {
          const sp = (Array.isArray(s.student_profiles)
            ? s.student_profiles[0]
            : s.student_profiles) as { grade?: string; class_group?: string } | null;
          return [
            s.id,
            {
              id: s.id,
              display_name: s.display_name ?? null,
              email: s.email,
              grade: sp?.grade ?? null,
              class_group: sp?.class_group ?? null,
            },
          ];
        }),
      );
    }

    const studentsByGroup: Record<string, string[]> = {};
    for (const m of members ?? []) {
      (studentsByGroup[m.class_group_id] ??= []).push(m.student_id);
    }

    classes = (groups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      campus: g.campus,
      grade: g.grade,
      students: (studentsByGroup[g.id] ?? [])
        .map((sid) => studentsById[sid])
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
        .sort((a, b) =>
          (a.display_name ?? a.email).localeCompare(b.display_name ?? b.email),
        ),
    }));
  }

  // Cross-class submission count for the "tests graded" stat. We pull
  // submissions where the test_assignments row includes this teacher
  // as one of the assigned teachers.
  const { data: assignmentRows } = await db
    .from("test_assignments")
    .select("test_id, teacher_ids")
    .contains("teacher_ids", JSON.stringify([teacherId]));
  const assignedTestIds = (assignmentRows ?? []).map((a) => a.test_id);

  let totalSubmissions = 0;
  if (assignedTestIds.length > 0) {
    const { count } = await db
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .in("test_id", assignedTestIds)
      .in("status", ["Submitted", "Late"]);
    totalSubmissions = count ?? 0;
  }

  const profile = (Array.isArray(teacher.teacher_profiles)
    ? teacher.teacher_profiles[0]
    : teacher.teacher_profiles) as { bio?: string; specialty?: string } | null;

  return {
    teacher: {
      id: teacher.id,
      display_name: teacher.display_name as string | null,
      email: teacher.email as string,
      account_status: teacher.account_status as string,
      created_at: teacher.created_at as string,
      can_review_questions: Boolean(teacher.can_review_questions),
      bio: profile?.bio ?? null,
      specialty: profile?.specialty ?? null,
    },
    classes,
    stats: {
      classCount: classes.length,
      studentCount: new Set(classes.flatMap((c) => c.students.map((s) => s.id))).size,
      assignedTests: assignedTestIds.length,
      totalSubmissions,
    },
  };
}

export default async function AdminTeacherDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const me = await getCurrentUser();
  if (!me || me.role !== "admin") redirect("/sign-in");

  const { id } = await params;
  const data = await getTeacherDetail(id);
  if (!data || isQaEmail(data.teacher.email) !== me.isQa) notFound();

  const { teacher, classes, stats } = data;

  return (
    <div className="space-y-6">
      <DetailHeader
        back={{ href: "/admin/teachers", label: "Teachers" }}
        title={teacher.display_name ?? teacher.email}
        badge={<StatusBadge kind="student" status={studentStatusLabel(teacher.account_status)} />}
        summary={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{teacher.email}</span>
            {teacher.specialty && (
              <>
                <span aria-hidden>·</span>
                <span>{teacher.specialty}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span>{teacher.can_review_questions ? "Can review questions" : "Not a reviewer"}</span>
            <span aria-hidden>·</span>
            <span title={formatDate(teacher.created_at)}>Joined {formatShortDate(teacher.created_at)}</span>
          </span>
        }
      />
      {teacher.bio && <p className="text-sm text-mid-gray whitespace-pre-line">{teacher.bio}</p>}

      <StatCards
        items={[
          { label: "Classes", value: stats.classCount },
          { label: "Students", value: stats.studentCount },
          { label: "Assigned tests", value: stats.assignedTests },
          { label: "Submissions", value: stats.totalSubmissions },
        ]}
      />

      {/* Classes */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-charcoal font-semibold text-lg">Classes &amp; students</h2>
          <Link
            href="/admin/classes"
            className="text-warm-coral-text text-xs hover:underline"
          >
            Manage classes →
          </Link>
        </div>

        {classes.length === 0 ? (
          <div className="bg-surface border border-divider rounded-2xl p-12 text-center">
            <Users size={28} className="text-charcoal/20 mx-auto" />
            <p className="text-soft-mute text-sm mt-3">
              This teacher isn&rsquo;t assigned to any class yet.
            </p>
            <Link
              href="/admin/classes"
              className="inline-block mt-3 px-4 py-2 rounded-xl bg-warm-coral/10 hover:bg-warm-coral/20 text-warm-coral-text text-xs font-medium transition-colors"
            >
              Assign in Classes
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {classes.map((cls) => (
              <div key={cls.id} className="space-y-2">
                <div>
                  <h3 className="text-charcoal font-semibold">{cls.name}</h3>
                  <p className="text-soft-mute text-xs mt-0.5">
                    {[cls.campus, cls.grade].filter(Boolean).join(" · ") || "—"}
                    {" · "}
                    {cls.students.length}{" "}
                    {cls.students.length === 1 ? "student" : "students"}
                  </p>
                </div>
                {cls.students.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-divider px-5 py-6 text-center text-soft-mute text-sm">
                    No students in this class yet. Add them in Classes.
                  </p>
                ) : (
                  <DataTable>
                    <thead>
                      <HeadRow>
                        <Th kind="main" sticky="left">Student</Th>
                        <Th>Grade</Th>
                        <Th priority="lg">Class group label</Th>
                        <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
                      </HeadRow>
                    </thead>
                    <tbody>
                      {cls.students.map((s) => (
                        <DataRow
                          key={s.id}
                          href={`/admin/students/${s.id}`}
                          expandBelow="lg"
                          colSpan={4}
                          details={
                            <DetailItem label="Class group label" priority="lg">
                              {s.class_group ?? "—"}
                            </DetailItem>
                          }
                        >
                          <Td kind="main" sticky="left">
                            <TwoLineCell
                              main={s.display_name ?? "—"}
                              detail={s.email}
                              wrapMain
                              mainClassName="font-medium text-charcoal"
                            />
                          </Td>
                          <Td className="text-mid-gray">{s.grade ?? "—"}</Td>
                          <Td priority="lg" className="text-mid-gray">
                            {s.class_group ?? "—"}
                          </Td>
                          <Td kind="actions" sticky="right">
                            <ExpandToggle label={`More about ${s.display_name ?? s.email}`} />
                          </Td>
                        </DataRow>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

