import Link from "next/link";
import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import PageIntro from "@/components/shared/PageIntro";
import { DataRow, DataTable, HeadRow, Td, Th, TwoLineCell } from "@/components/ui/data-table";

export const dynamic = "force-dynamic";

interface AssignmentRow {
  class_group_id: string;
  class_group: {
    id: string;
    name: string;
    campus: string | null;
    grade: string | null;
  } | null;
}

async function getMyClasses(teacherId: string) {
  const db = getServiceClient();
  const { data: rows } = await db
    .from("class_group_teachers")
    .select(
      `class_group_id,
       class_group:class_groups!class_group_id(id, name, campus, grade)`,
    )
    .eq("teacher_id", teacherId);

  const groups = ((rows ?? []) as unknown as AssignmentRow[])
    .map((r) =>
      Array.isArray(r.class_group) ? r.class_group[0] : r.class_group,
    )
    .filter((g): g is NonNullable<typeof g> => Boolean(g));

  if (groups.length === 0) return [];

  const ids = groups.map((g) => g.id);
  const { data: members } = await db
    .from("class_group_members")
    .select("class_group_id")
    .in("class_group_id", ids);

  const counts: Record<string, number> = {};
  for (const m of members ?? []) {
    counts[m.class_group_id] = (counts[m.class_group_id] ?? 0) + 1;
  }

  return groups.map((g) => ({ ...g, studentCount: counts[g.id] ?? 0 }));
}

export default async function TeacherClassesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  if (user.role !== "teacher" && user.role !== "admin") redirect("/dashboard");

  const classes = await getMyClasses(user.userId);

  return (
    <div className="space-y-6">
      <PageIntro tKey="teacher.classes" />
      <div>
        <h1 className="text-2xl font-bold text-charcoal flex items-center gap-2">
          <Users size={20} />
          My Classes
        </h1>
        <p className="text-soft-mute text-sm mt-1">
          Groups your admin assigned you to. Open one to see its roster and per-student progress.
        </p>
      </div>

      {classes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-divider py-16 text-center space-y-2">
          <Users size={36} className="text-charcoal/20 mx-auto" />
          <p className="text-soft-mute text-sm">
            No classes assigned yet. Ask your admin to add you to a group.
          </p>
        </div>
      ) : (
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">Class</Th>
              <Th>Grade</Th>
              <Th>Students</Th>
            </HeadRow>
          </thead>
          <tbody>
            {classes.map((c) => (
              <DataRow key={c.id} href={`/teacher/classes/${c.id}`}>
                <Td kind="main" sticky="left">
                  <Link href={`/teacher/classes/${c.id}`} className="block text-charcoal hover:text-warm-coral-text transition-colors">
                    <TwoLineCell main={c.name} detail={c.campus ?? undefined} wrapMain mainClassName="font-medium text-inherit" />
                  </Link>
                </Td>
                <Td className="text-mid-gray">{c.grade ?? "—"}</Td>
                <Td className="text-mid-gray">
                  {c.studentCount} {c.studentCount === 1 ? "student" : "students"}
                </Td>
              </DataRow>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
