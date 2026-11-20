import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, ClipboardList } from "lucide-react";
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
import { M2_NOT_TAKEN_COLUMN } from "@/lib/module2-not-taken";
import { attemptScore, averageSat, type ScoreDisplay } from "@/lib/score-display";
import { fullLengthLinksOrNone } from "@/lib/full-length";
import { flModuleCells, flStatusText, fullLengthAttemptScore, loadFlAttemptMeta, flAttemptKey, scopedFlScore } from "@/lib/full-length-score";
import type { RecentScoreItem } from "@/lib/recent-scores";
import { ScoreCell } from "@/components/ui/ScoreCell";
import { StatusBadge, attemptStatusLabel } from "@/components/ui/StatusBadge";
import { formatShortDate, formatShortDateTime, formatDateTime } from "@/lib/datetime";
import StudentInsights from "@/components/analytics/StudentInsights";
import RecentPracticeTests from "@/components/analytics/RecentPracticeTests";
import ScoreProgressChart from "@/components/analytics/ScoreProgressChart";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import StudentConclusions from "@/components/analytics/StudentConclusions";
import StudentTabs from "@/components/students/StudentTabs";
import StudentProfileCard from "@/components/students/StudentProfileCard";
import { getStudentProgressOccasions } from "@/lib/student-analytics";
import type { Occasion } from "@/lib/score-analysis";
import { getTranslations } from "next-intl/server";
import {
  DataRow,
  DataTable,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  HeadRow,
  Td,
  Th,
  TruncatedText,
  ClampText,
  TwoLineCell,
} from "@/components/ui/data-table";

export const dynamic = "force-dynamic";

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
    // Grade only: teachers already see it on results; no parent contact / notes.
    db.from("users").select("id, email, display_name, student_profiles(grade)").eq("id", studentId).maybeSingle(),
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
       started_at, submitted_at, session_id, adaptive_track, attempt_number, module_id, ${M2_NOT_TAKEN_COLUMN},
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
    attempt_number: number | null;
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
  // Full-length SAT section rows are listed as one attempt under the parent
  // (the total, both sections); the teacher of either subject sees it.
  const flLinks = await fullLengthLinksOrNone(db);
  const allRows = (subs ?? []) as unknown as SubRow[];
  const flRows = allRows.filter((r) => flLinks.parentOf.has(r.test_id));
  const rows = allRows.filter((r) => !flLinks.parentOf.has(r.test_id));
  const [qaTests, assignments] = await Promise.all([
    getQaTestIds(),
    getStudentAssignments(db, studentId),
  ]);
  const sectionOf = await getTestSections(
    db,
    Array.from(new Set([...rows.map((r) => r.test_id), ...assignments.keys()])),
    { strict: true },
  );
  const visible = (testId: string) =>
    onSide(testId, qaTests, isQa) &&
    (flLinks.childrenOf.has(testId) || inSubjects(sectionOf.get(testId) ?? null, subjects));
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

  // "Recent practice tests": finished attempts, same scores as the table.
  const recentItems: RecentScoreItem[] = [];

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
    // Module 2 closed unopened (lib/module2-not-taken): Incomplete, also on an older attempt.
    const attempt = attemptScore(sorted, sectionOf.get(head.test_id));
    if (attempt.status === "Incomplete") status = "Incomplete";
    const submittedAt = sorted.map((r) => r.submitted_at).filter((d): d is string => !!d).sort().pop() ?? null;
    if ((status === "Submitted" || status === "Late") && attempt.score?.pct != null && submittedAt) {
      recentItems.push({
        key: last.id,
        date: submittedAt,
        testName: t?.test_name ?? "—",
        href: `/teacher/tests/${head.test_id}/results/${last.id}`,
        kind: "section",
        sections: [
          {
            section: sectionOf.get(head.test_id) ?? "",
            sat: attempt.score.sat,
            modules: attempt.modules.filter((m) => !m.notTaken).map((m) => `${m.correct ?? 0}/${m.total ?? 0}`),
          },
        ],
        total: null,
        estimated: attempt.score.estimated,
      });
    }
    return {
      // Detail page stitches both modules via session_id from the last one.
      id: last.id,
      submissionIds: sorted.map((r) => r.id),
      testId: head.test_id,
      testName: t?.test_name ?? "—",
      dueDate: t?.due_date ?? null,
      section: sectionOf.get(head.test_id) ?? null,
      status,
      module:
        isLatest && status === "In progress" && progress.currentModule != null
          ? { n: progress.currentModule, of: progress.moduleCount }
          : null,
      assignedVia: assignedVia(head.test_id),
      assignedAt: assignments.get(head.test_id)?.assignedAt ?? null,
      hasSubmission: true,
      score: attempt.score,
      submittedAt,
      href: undefined as string | undefined,
      fullLength: false,
    };
  });

  // Full-length SAT attempts: one row each, under the parent.
  const flParentIds = Array.from(new Set(flRows.map((r) => flLinks.parentOf.get(r.test_id)!))).filter((p) => visible(p));
  const [flMeta, { data: flParentMeta }] = await Promise.all([
    loadFlAttemptMeta(db, flParentIds, studentId),
    flParentIds.length
      ? db.from("tests").select("id, test_name, due_date").in("id", flParentIds)
      : Promise.resolve({ data: [] as { id: string; test_name: string; due_date: string | null }[] }),
  ]);
  const flParentById = new Map(((flParentMeta ?? []) as { id: string; test_name: string; due_date: string | null }[]).map((t) => [t.id, t]));
  const flGroups = new Map<string, SubRow[]>();
  for (const r of flRows) {
    const parent = flLinks.parentOf.get(r.test_id)!;
    if (!visible(parent)) continue;
    const k = flAttemptKey(parent, r.student_id, r.attempt_number ?? 1);
    flGroups.set(k, [...(flGroups.get(k) ?? []), r]);
  }
  const flTested = new Set<string>();
  for (const [k, list] of flGroups) {
    const parent = flLinks.parentOf.get(list[0].test_id)!;
    flTested.add(parent);
    const kids = flLinks.childrenOf.get(parent);
    // The total plus only the section(s) this teacher teaches the class.
    const fl = scopedFlScore(
      fullLengthAttemptScore(
        list.filter((r) => r.test_id !== kids?.math),
        list.filter((r) => r.test_id === kids?.math),
        flMeta.get(k),
      ),
      { rw: inSubjects("Reading & Writing", subjects), math: inSubjects("Math", subjects) },
    );
    const done = fl.status === "Submitted" || fl.status === "Late";
    const ordered = [...list].sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
    const last = ordered[ordered.length - 1];
    const p = flParentById.get(parent);
    const flSubmittedAt = ordered.map((r) => r.submitted_at).filter((d): d is string => !!d).sort().pop() ?? null;
    if (done && flSubmittedAt) {
      recentItems.push({
        key: `fl:${k}`,
        date: flSubmittedAt,
        testName: p?.test_name ?? "—",
        href: `/teacher/tests/${parent}/results`,
        kind: "full",
        // The total plus only the section(s) this teacher may see.
        sections: [
          ...(inSubjects("Reading & Writing", subjects)
            ? [{ section: "Reading & Writing", sat: fl.rw.score?.sat ?? null, modules: flModuleCells(fl.rw) }]
            : []),
          ...(inSubjects("Math", subjects)
            ? [{ section: "Math", sat: fl.math.score?.sat ?? null, modules: flModuleCells(fl.math) }]
            : []),
        ],
        total: fl.total,
        estimated: fl.score?.estimated,
      });
    }
    submissions.push({
      id: last.id,
      submissionIds: list.map((r) => r.id),
      testId: parent,
      testName: p?.test_name ?? "—",
      dueDate: p?.due_date ?? null,
      section: "Full-length SAT",
      status: done || fl.status === "Incomplete" ? fl.status : fl.status === "Not started" ? "Not started" : fl.status.startsWith("Closed") ? flStatusText(fl) : "In progress",
      module: null,
      assignedVia: assignedVia(parent),
      assignedAt: assignments.get(parent)?.assignedAt ?? null,
      hasSubmission: true,
      score: fl.score,
      submittedAt: flSubmittedAt,
      href: `/teacher/tests/${parent}/results`,
      fullLength: true,
    });
  }

  // Assigned tests (directly or via a class) the student hasn't started.
  const notStarted = Array.from(assignments.values())
    .filter((a) => !subsByTest.has(a.testId) && !flTested.has(a.testId))
    .map((a) => {
      const t = testById.get(a.testId);
      return {
        id: `assigned-${a.testId}`,
        submissionIds: [] as string[],
        testId: a.testId,
        testName: t?.test_name ?? "—",
        dueDate: t?.due_date ?? null,
        section: sectionOf.get(a.testId) ?? null,
        status: "Not started",
        score: null as ScoreDisplay | null,
        submittedAt: null as string | null,
        module: null as { n: number; of: number } | null,
        assignedVia: assignedVia(a.testId),
        assignedAt: a.assignedAt,
        hasSubmission: false,
        href: undefined as string | undefined,
        fullLength: flLinks.childrenOf.has(a.testId),
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
  const assigned = new Set<string>([...assignments.keys(), ...subsByTest.keys(), ...flTested]);

  return { group, student, submissions, tests, subjects, assignedCount: assigned.size, recentItems };
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
  const { group, student, submissions, tests, subjects, assignedCount, recentItems } = data;
  // Only the subject(s) this teacher teaches the class.
  // (The takeaways read these too, so a single-subject teacher's conclusions
  // only use their section.)
  const [allOccasions, tt] = await Promise.all([
    getStudentProgressOccasions(studentId, { habits: true }),
    getTranslations("studentTabs"),
  ]);
  const occasions = allOccasions
    .map((o) => ({ ...o, rows: o.rows.filter((r) => inSubjects(r.section, subjects)) }))
    .filter((o) => o.rows.length > 0 && inSubjects(o.section, subjects));
  const occBySubmission = new Map<string, Occasion>();
  for (const o of occasions) for (const sid of o.submissionIds ?? []) occBySubmission.set(sid, o);
  const breakdownRows = (submissionIds: string[]) =>
    Array.from(new Set(submissionIds.map((sid) => occBySubmission.get(sid)).filter((o): o is Occasion => Boolean(o))))
      .flatMap((o) => o.rows);
  const profileRow = (student as { student_profiles?: { grade?: string | null } | { grade?: string | null }[] | null })
    .student_profiles;
  const grade = (Array.isArray(profileRow) ? profileRow[0] : profileRow)?.grade ?? null;

  const completed = submissions.filter(
    (s) => s.status === "Submitted" || s.status === "Late",
  );
  // Averages use finished attempts only (SAT needs every module in).
  // Full-length totals (400–1600) are on another scale: left out.
  const sectionCompleted = completed.filter((s) => !s.fullLength);
  const avgSat = averageSat(sectionCompleted.map((s) => s.score?.sat));
  const pcts = sectionCompleted.map((s) => s.score?.pct).filter((p): p is number => p != null);
  const avgPct = pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;

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
        {occasions.length > 0 && (
          <Link href={`/print/students/${studentId}/report`} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-divider text-sm font-semibold text-charcoal hover:bg-light-bg transition-colors whitespace-nowrap">
            Download one-page report
          </Link>
        )}
      </div>

      <StudentTabs
        panels={[
          {
            id: "overview",
            label: tt("overview"),
            content: (
              <>
                {/* Lead with the real practice-test scores. */}
                <RecentPracticeTests items={recentItems} />
                {occasions.length > 1 && <ScoreProgressChart occasions={occasions} />}
                <StudentConclusions occasions={occasions} studentId={studentId} displayName={student.display_name} />
                <div className="grid grid-cols-3 gap-4">
                  <Stat label="Tests assigned" value={String(assignedCount)} />
                  <Stat label="Completed" value={String(new Set(completed.map((s) => s.testId)).size)} />
                  <Stat
                    label="Avg SAT"
                    value={avgSat == null ? "—" : String(avgSat)}
                    detail={avgPct == null ? undefined : `${avgPct.toFixed(1)}% correct`}
                  />
                </div>
              </>
            ),
          },
          {
            id: "tests",
            label: tt("tests"),
            content: (
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
              const isDone = s.status === "Submitted" || s.status === "Late" || s.status === "Incomplete";
              const dueStr = s.dueDate ? formatShortDate(s.dueDate) : null;
              const assignedStr = s.assignedAt ? formatShortDate(s.assignedAt) : "—";
              const submittedStr = s.submittedAt
                ? formatShortDateTime(s.submittedAt)
                : "—";
              const submittedFull = s.submittedAt
                ? formatDateTime(s.submittedAt)
                : null;
              // This test's domain breakdown (was "Score Report — By Test"):
              // in the details row, which then opens at every width.
              const bRows = breakdownRows(s.submissionIds);

              return (
                <DataRow
                  key={s.id}
                  href={s.href ?? (isDone && s.hasSubmission ? `/teacher/tests/${s.testId}/results/${s.id}` : `/teacher/tests/${s.testId}`)}
                  expandBelow={bRows.length > 0 ? "never" : "lg"}
                  colSpan={6}
                  details={
                    <>
                      <DetailItem label="Dates" priority="lg">
                        {`${dueStr ? `Due: ${dueStr} · ` : ""}Assigned: ${assignedStr} · Submitted: ${submittedStr}`}
                      </DetailItem>
                      <DetailItem label="Assigned via" priority="lg">
                        {s.assignedVia}
                      </DetailItem>
                      {bRows.length > 0 && (
                        <div className="sm:col-span-2 -mx-1">
                          <ScoreBreakdown rows={bRows} title={tt("breakdownTitle")} />
                        </div>
                      )}
                    </>
                  }
                >
                  <Td kind="main" sticky="left">
                    <TwoLineCell
                      main={<ClampText>{s.testName}</ClampText>}
                      detail={s.section ?? undefined}
                      mainClassName="font-medium text-charcoal"
                    />
                  </Td>
                  <Td priority="lg">
                    <TwoLineCell
                      main={dueStr ? `Due: ${dueStr}` : `Assigned ${assignedStr}`}
                      detail={
                        submittedFull
                          ? <span title={submittedFull}>{`Submitted ${submittedStr}`}</span>
                          : dueStr
                          ? `Assigned ${assignedStr}`
                          : undefined
                      }
                      mainClassName="text-mid-gray"
                    />
                  </Td>
                  <Td>
                    <StatusBadge kind="attempt" status={attemptStatusLabel(s.status)} module={s.module} />
                  </Td>
                  <Td kind="long" priority="lg" className="w-[16%]">
                    <TruncatedText className="text-mid-gray">{s.assignedVia}</TruncatedText>
                  </Td>
                  <Td>
                    <ScoreCell score={s.score} />
                  </Td>
                  <Td kind="actions" sticky="right">
                    <ExpandToggle label={`More about ${s.testName}`} />
                  </Td>
                </DataRow>
              );
            })}
          </tbody>
        </DataTable>
      </section>
            ),
          },
          {
            id: "skills",
            label: tt("skills"),
            content: occasions.length === 0
              ? <p className="text-sm text-soft-mute">{tt("skillsEmpty")}</p>
              : <StudentInsights occasions={occasions} name={student.display_name ?? student.email} />,
          },
          {
            id: "profile",
            label: tt("profileTab"),
            // What a teacher may see: no parent contact or notes.
            content: (
              <StudentProfileCard
                fields={[
                  ["email", student.email],
                  ["grade", grade],
                  ["classGroup", group.name],
                  ["campus", group.campus],
                ]}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="bg-surface border border-divider rounded-2xl p-4">
      <p className="text-soft-mute text-xs">{label}</p>
      <p className="text-2xl font-bold text-charcoal mt-1">{value}</p>
      {detail && <p className="text-soft-mute text-xs">{detail}</p>}
    </div>
  );
}
