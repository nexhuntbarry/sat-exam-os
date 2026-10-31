import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ClipboardList, Eye, FileText } from "lucide-react";
import { clsx } from "clsx";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, getQaUserIds, onSide } from "@/lib/qa";
import {
  getTeacherSubjectsForStudent,
  getTestSections,
  inSubjects,
} from "@/lib/teacher-access";
import { getServiceClient } from "@/lib/supabase";
import { getStudentAssignments } from "@/lib/student-exam";
import { studentTestProgress } from "@/lib/test-progress";
import { formatShortDate, formatShortDateTime, formatDateTime } from "@/lib/datetime";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import ProgressReport from "@/components/analytics/ProgressReport";
import ScoreProgressChart from "@/components/analytics/ScoreProgressChart";
import PerTestBreakdown from "@/components/analytics/PerTestBreakdown";
import { getStudentBreakdownRows, getStudentProgressOccasions } from "@/lib/student-analytics";
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

const statusCls: Record<string, string> = {
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  "In progress": "bg-warm-coral/15 text-warm-coral-text",
  "Not started": "bg-light-bg text-mid-gray",
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
  // without requiring the teacher to be on test_assignments.teacher_ids,
  // plus every test assigned to the student in those subjects (started or
  // not).
  const subjects = isAdmin
    ? null
    : (await getTeacherSubjectsForStudent(db, teacherId, studentId, classGroupId)).subjects;

  const { data: subs } = await db
    .from("submissions")
    .select(
      `id, test_id, student_id, status, score, percentage, correct_count, total_questions,
       started_at, submitted_at, session_id, adaptive_track,
       tests!inner(id, test_name, due_date, is_adaptive, module_2_id)`,
    )
    .eq("student_id", studentId)
    .order("submitted_at", { ascending: false, nullsFirst: false })
    .order("started_at", { ascending: false });

  type SubRow = {
    id: string;
    test_id: string;
    student_id: string;
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
      | TestMeta
      | TestMeta[]
      | null;
  };
  type TestMeta = {
    id: string;
    test_name: string;
    due_date: string | null;
    is_adaptive: boolean | null;
    module_2_id: string | null;
  };
  const rows = (subs ?? []) as unknown as SubRow[];
  const [qaTests, assignments] = await Promise.all([
    getQaTestIds(),
    getStudentAssignments(db, studentId),
  ]);
  const sectionOf = await getTestSections(
    db,
    Array.from(new Set([...rows.map((r) => r.test_id), ...assignments.keys()])),
  );
  const visible = (testId: string) =>
    onSide(testId, qaTests, isQa) && inSubjects(sectionOf.get(testId) ?? null, subjects);
  for (const testId of Array.from(assignments.keys())) {
    if (!visible(testId)) assignments.delete(testId);
  }

  const subsByTest = new Map<string, SubRow[]>();
  for (const r of rows) {
    if (visible(r.test_id)) subsByTest.set(r.test_id, [...(subsByTest.get(r.test_id) ?? []), r]);
  }
  const [{ data: assignedMeta }, { data: classGroups }] = await Promise.all([
    assignments.size > 0
      ? db
          .from("tests")
          .select("id, test_name, due_date, is_adaptive, module_2_id")
          .in("id", Array.from(assignments.keys()))
      : Promise.resolve({ data: [] as TestMeta[] }),
    (() => {
      const ids = Array.from(new Set(Array.from(assignments.values()).flatMap((a) => a.classGroupIds)));
      return ids.length > 0
        ? db.from("class_groups").select("id, name").in("id", ids)
        : Promise.resolve({ data: [] as { id: string; name: string }[] });
    })(),
  ]);
  const testById = new Map<string, TestMeta>(
    ((assignedMeta ?? []) as TestMeta[]).map((t) => [t.id, t]),
  );
  for (const r of rows) {
    const t = Array.isArray(r.tests) ? r.tests[0] : r.tests;
    if (t && !testById.has(r.test_id)) testById.set(r.test_id, t);
  }
  const className = new Map((classGroups ?? []).map((c) => [c.id as string, c.name as string]));
  const progressOf = (testId: string) => {
    const t = testById.get(testId);
    return studentTestProgress(subsByTest.get(testId) ?? [], Boolean(t?.module_2_id || t?.is_adaptive));
  };
  const assignedVia = (testId: string) => {
    const a = assignments.get(testId);
    if (!a) return "Not assigned";
    return [
      ...(a.direct ? ["Individually"] : []),
      ...a.classGroupIds.map((g) => className.get(g) ?? "Class"),
    ].join(", ");
  };

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
    let status = statuses.includes("In Progress")
      ? "In progress"
      : statuses.includes("Late")
      ? "Late"
      : last.status;
    // The latest attempt takes the test-level progress (e.g. Module 1 in,
    // Module 2 not yet started is still In progress).
    const startedAt = sorted.map((r) => r.started_at ?? "").sort()[0] ?? "";
    const isLatest = !(subsByTest.get(head.test_id) ?? []).some(
      (r) => (r.started_at ?? "") > startedAt && !sorted.includes(r),
    );
    const progress = progressOf(head.test_id);
    if (isLatest && progress.status !== "Submitted") status = progress.status;
    return {
      // Detail page stitches both modules via session_id from the last one.
      id: last.id,
      testId: head.test_id,
      testName: t?.test_name ?? "—",
      dueDate: t?.due_date ?? null,
      section: sectionOf.get(head.test_id) ?? null,
      status,
      moduleLabel:
        isLatest && status === "In progress" && progress.currentModule != null
          ? `Module ${progress.currentModule} of ${progress.moduleCount}`
          : null,
      assignedVia: assignedVia(head.test_id),
      assignedAt: assignments.get(head.test_id)?.assignedAt ?? null,
      hasSubmission: true,
      percentage: sorted.length > 1
        ? total > 0 ? Math.round((correct / total) * 1000) / 10 : null
        : head.percentage == null ? null : Number(head.percentage),
      submittedAt: sorted.map((r) => r.submitted_at).filter((d): d is string => !!d).sort().pop() ?? null,
    };
  });

  // Assigned tests (directly or via a class) the student hasn't started.
  const notStarted = Array.from(assignments.values())
    .filter((a) => !subsByTest.has(a.testId))
    .map((a) => {
      const t = testById.get(a.testId);
      return {
        id: `assigned-${a.testId}`,
        testId: a.testId,
        testName: t?.test_name ?? "—",
        dueDate: t?.due_date ?? null,
        section: sectionOf.get(a.testId) ?? null,
        status: "Not started",
        percentage: null as number | null,
        submittedAt: null as string | null,
        moduleLabel: null as string | null,
        assignedVia: assignedVia(a.testId),
        assignedAt: a.assignedAt,
        hasSubmission: false,
      };
    });
  // Not started / in progress first (soonest due first), then finished
  // attempts, most recent first.
  const isOpen = (s: { status: string }) => s.status === "Not started" || s.status === "In progress";
  const tests = [
    ...[...notStarted, ...submissions.filter(isOpen)].sort(
      (a, b) =>
        (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
        a.testName.localeCompare(b.testName),
    ),
    ...submissions
      .filter((s) => !isOpen(s))
      .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "")),
  ];

  // Assigned = tests assigned to the student (directly or via a class)
  // plus any they took, in the teacher's subject(s).
  const assigned = new Set<string>([...assignments.keys(), ...subsByTest.keys()]);

  return { group, student, submissions, tests, subjects, assignedCount: assigned.size };
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
  const { group, student, submissions, tests, subjects, assignedCount } = data;
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

      <section>
        <div className="flex items-center gap-2 mb-3">
          <ClipboardList size={15} className="text-charcoal" />
          <h2 className="text-charcoal font-semibold">Tests</h2>
        </div>
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">Test</Th>
              <Th priority="lg">Dates</Th>
              <Th>Status</Th>
              <Th kind="long" priority="lg" className="w-[16%]">Assigned via</Th>
              <Th>Score</Th>
              <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {tests.length === 0 && (
              <EmptyRow colSpan={6}>
                No tests assigned to this student under your account yet.
              </EmptyRow>
            )}
            {tests.map((s) => {
              const isDone = s.status === "Submitted" || s.status === "Late";
              const dueStr = s.dueDate ? formatShortDate(s.dueDate) : "—";
              const assignedStr = s.assignedAt ? formatShortDate(s.assignedAt) : "—";
              const submittedStr = s.submittedAt
                ? formatShortDateTime(s.submittedAt)
                : "—";
              const submittedFull = s.submittedAt
                ? formatDateTime(s.submittedAt)
                : null;

              return (
                <DataRow
                  key={s.id}
                  expandBelow="lg"
                  colSpan={6}
                  details={
                    <>
                      <DetailItem label="Dates" priority="lg">
                        {`Due: ${dueStr} · Assigned: ${assignedStr} · Submitted: ${submittedStr}`}
                      </DetailItem>
                      <DetailItem label="Assigned via" priority="lg">
                        {s.assignedVia}
                      </DetailItem>
                    </>
                  }
                >
                  <Td kind="main" sticky="left">
                    <TwoLineCell
                      main={<TruncatedText>{s.testName}</TruncatedText>}
                      detail={s.section ?? undefined}
                      mainClassName="font-medium text-charcoal"
                    />
                  </Td>
                  <Td priority="lg">
                    <TwoLineCell
                      main={`Due: ${dueStr}`}
                      detail={
                        submittedFull
                          ? <span title={submittedFull}>{`Submitted ${submittedStr}`}</span>
                          : `Assigned ${assignedStr}`
                      }
                      mainClassName="text-mid-gray"
                    />
                  </Td>
                  <Td>
                    <span
                      className={clsx(
                        "px-2 py-0.5 rounded-full text-xs font-medium",
                        statusCls[s.status] ?? "bg-light-bg text-mid-gray",
                      )}
                    >
                      {s.status}
                    </span>
                    {s.moduleLabel && (
                      <div className="text-[11px] text-soft-mute mt-0.5 whitespace-nowrap">
                        {s.moduleLabel}
                      </div>
                    )}
                  </Td>
                  <Td kind="long" priority="lg" className="w-[16%]">
                    <TruncatedText className="text-mid-gray">{s.assignedVia}</TruncatedText>
                  </Td>
                  <Td>
                    {s.percentage == null ? (
                      <span className="text-soft-mute text-xs">—</span>
                    ) : (
                      <span
                        className={clsx(
                          "text-xs font-medium",
                          s.percentage < 60
                            ? "text-status-error"
                            : s.percentage < 80
                            ? "text-warm-amber"
                            : "text-status-success",
                        )}
                      >
                        {s.percentage.toFixed(0)}%
                      </span>
                    )}
                  </Td>
                  <Td kind="actions" sticky="right">
                    <ExpandToggle label={`More about ${s.testName}`} />
                    <RowActionsMenu
                      label={`Actions for ${s.testName}`}
                      items={[
                        {
                          label: "Open test",
                          icon: <FileText size={14} />,
                          href: `/teacher/tests/${s.testId}`,
                        },
                        isDone && s.hasSubmission && {
                          label: "View detail",
                          icon: <Eye size={14} />,
                          href: `/teacher/tests/${s.testId}/results/${s.id}`,
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface border border-divider rounded-2xl p-4">
      <p className="text-soft-mute text-xs">{label}</p>
      <p className="text-2xl font-bold text-charcoal mt-1">{value}</p>
    </div>
  );
}
