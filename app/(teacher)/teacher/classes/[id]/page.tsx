import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, MapPin, GraduationCap, Users, Eye } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, onSide } from "@/lib/qa";
import { getTestSections, inSubjects } from "@/lib/teacher-access";
import { getServiceClient } from "@/lib/supabase";
import { formatShortDateTime } from "@/lib/datetime";
import {
  DataRow,
  DataTable,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  HeadRow,
  RowActionsMenu,
  Td,
  Th,
  TruncatedText,
  TwoLineCell,
} from "@/components/ui/data-table";

export const dynamic = "force-dynamic";

async function loadClass(id: string, teacherId: string, isAdmin: boolean, isQa: boolean) {
  const db = getServiceClient();

  // Teacher must be assigned to this group; admin sees everything. The
  // link's subject (NULL = both) scopes which tests count below.
  let subjects: string[] | null = null;
  if (!isAdmin) {
    const { data: link } = await db
      .from("class_group_teachers")
      .select("id, subject")
      .eq("class_group_id", id)
      .eq("teacher_id", teacherId)
      .maybeSingle();
    if (!link) return null;
    subjects = link.subject ? [link.subject as string] : null;
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
  const [{ data: subs }, { data: assignments }] = await Promise.all([
    studentIds.length
      ? db
          .from("submissions")
          .select(
            "id, student_id, status, correct_count, total_questions, percentage, submitted_at, session_id, test_id, tests!inner(test_name)",
          )
          .in("student_id", studentIds)
          .order("submitted_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    db.from("test_assignments").select("test_id, student_ids, class_group_ids"),
  ]);

  type Sub = {
    id: string;
    student_id: string;
    status: string;
    correct_count: number | null;
    total_questions: number | null;
    percentage: number | string | null;
    submitted_at: string | null;
    session_id: string | null;
    test_id: string;
    tests:
      | { test_name: string }
      | { test_name: string }[]
      | null;
  };
  const subRows = (subs ?? []) as unknown as Sub[];

  // Only tests on the viewer's QA side and in the subject this teacher
  // teaches the class.
  const qaTests = await getQaTestIds();
  const candidateTests = new Set<string>(subRows.map((s) => s.test_id));
  for (const a of assignments ?? []) candidateTests.add(a.test_id as string);
  const sectionOf = await getTestSections(db, Array.from(candidateTests));
  const visible = (testId: string) =>
    onSide(testId, qaTests, isQa) && inSubjects(sectionOf.get(testId) ?? null, subjects);

  // Assigned per student = tests assigned to this class ∪ assigned to the
  // student individually ∪ tests they took.
  const classTests = new Set<string>();
  const assignedTo: Record<string, Set<string>> = {};
  for (const a of assignments ?? []) {
    const testId = a.test_id as string;
    if (!visible(testId)) continue;
    if (((a.class_group_ids as string[] | null) ?? []).includes(id)) classTests.add(testId);
    for (const sid of (a.student_ids as string[] | null) ?? []) {
      (assignedTo[sid] ??= new Set()).add(testId);
    }
  }

  // Group module rows into attempts (two-module attempts share a session_id).
  const attempts = new Map<string, Sub[]>();
  for (const s of subRows) {
    if (!visible(s.test_id)) continue;
    const key = s.session_id ?? s.id;
    attempts.set(key, [...(attempts.get(key) ?? []), s]);
  }

  type Latest = { test_name: string; submitted_at: string | null; percentage: number | null };
  const perStudent: Record<
    string,
    { total: number; completed: number; scores: number[]; latest: Latest | null }
  > = {};
  const tested: Record<string, Set<string>> = {};
  const completedTests: Record<string, Set<string>> = {};
  for (const rows of attempts.values()) {
    const head = rows[0];
    const sid = head.student_id;
    const slot = (perStudent[sid] ??= { total: 0, completed: 0, scores: [], latest: null });
    (tested[sid] ??= new Set()).add(head.test_id);
    if (!rows.every((r) => r.status === "Submitted" || r.status === "Late")) continue;
    (completedTests[sid] ??= new Set()).add(head.test_id);
    const correct = rows.reduce((n, r) => n + (r.correct_count ?? 0), 0);
    const total = rows.reduce((n, r) => n + (r.total_questions ?? 0), 0);
    const pct = rows.length > 1
      ? total > 0 ? Math.round((correct / total) * 1000) / 10 : null
      : head.percentage == null ? null : Number(head.percentage);
    if (pct != null) slot.scores.push(pct);
    const submittedAt = rows.map((r) => r.submitted_at).filter((d): d is string => !!d).sort().pop() ?? null;
    if (!slot.latest || (submittedAt ?? "") > (slot.latest.submitted_at ?? "")) {
      const t = (Array.isArray(head.tests) ? head.tests[0] : head.tests) as
        | { test_name: string }
        | null;
      slot.latest = { test_name: t?.test_name ?? "—", submitted_at: submittedAt, percentage: pct };
    }
  }
  for (const sid of studentIds) {
    const all = new Set([...classTests, ...(assignedTo[sid] ?? []), ...(tested[sid] ?? [])]);
    if (all.size === 0 && !perStudent[sid]) continue;
    const slot = (perStudent[sid] ??= { total: 0, completed: 0, scores: [], latest: null });
    slot.total = all.size;
    slot.completed = completedTests[sid]?.size ?? 0;
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
  if (!onSide(id, await getQaClassGroupIds(), me.isQa)) notFound();
  const data = await loadClass(id, me.userId, me.role === "admin", me.isQa);
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

      <section>
        <h2 className="text-charcoal font-semibold mb-3">Roster</h2>
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">Student</Th>
              <Th>Progress</Th>
              <Th kind="long" priority="lg" className="w-[28%]">Latest</Th>
              <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {students.length === 0 && (
              <EmptyRow colSpan={4}>No students in this class yet.</EmptyRow>
            )}
            {students.map((s) => {
              const stats = perStudent[s.id] ?? { total: 0, completed: 0, scores: [], latest: null };
              const avg =
                stats.scores.length > 0
                  ? stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length
                  : null;
              const avgStr = avg == null ? "—" : `${avg.toFixed(1)}%`;
              const latestName = stats.latest?.test_name ?? null;
              const latestDetail = stats.latest
                ? [
                    stats.latest.percentage != null
                      ? `${stats.latest.percentage.toFixed(0)}%`
                      : null,
                    stats.latest.submitted_at
                      ? formatShortDateTime(stats.latest.submitted_at)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : null;
              const name = s.display_name ?? s.email;

              return (
                <DataRow
                  key={s.id}
                  expandBelow="lg"
                  colSpan={4}
                  details={
                    <DetailItem label="Latest" priority="lg">
                      {latestName
                        ? `${latestName}${latestDetail ? ` · ${latestDetail}` : ""}`
                        : "—"}
                    </DetailItem>
                  }
                >
                  <Td kind="main" sticky="left">
                    <Link
                      href={`/teacher/classes/${group.id}/students/${s.id}`}
                      className="block hover:text-warm-coral-text transition-colors"
                    >
                      <TwoLineCell
                        main={s.display_name ?? s.email}
                        detail={s.display_name ? s.email : undefined}
                        mainClassName="font-medium text-inherit"
                      />
                    </Link>
                  </Td>
                  <Td>
                    <TwoLineCell
                      main={`${stats.completed}/${stats.total} done`}
                      detail={avgStr !== "—" ? `Avg ${avgStr}` : undefined}
                      mainClassName="text-mid-gray"
                    />
                  </Td>
                  <Td kind="long" priority="lg">
                    {latestName ? (
                      <TwoLineCell
                        main={<TruncatedText>{latestName}</TruncatedText>}
                        detail={latestDetail ?? undefined}
                        mainClassName="text-charcoal"
                      />
                    ) : (
                      <span className="text-soft-mute">—</span>
                    )}
                  </Td>
                  <Td kind="actions" sticky="right">
                    <ExpandToggle label={`More about ${name}`} />
                    <RowActionsMenu
                      label={`Actions for ${name}`}
                      items={[
                        {
                          label: "View tests",
                          icon: Eye,
                          href: `/teacher/classes/${group.id}/students/${s.id}`,
                        },
                      ]}
                    />
                  </Td>
                </DataRow>
              );
            })}
          </tbody>
        </DataTable>
      </section>
    </div>
  );
}
