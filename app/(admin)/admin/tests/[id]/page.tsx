import { getServiceClient } from "@/lib/supabase";
import { studentTestProgress, summarizeTestProgress } from "@/lib/test-progress";
import { scoreDisplay, averageSat } from "@/lib/score-display";
import { ScoreCell } from "@/components/ui/ScoreCell";
import { StatusBadge, SubjectTag, type TestStatus } from "@/components/ui/StatusBadge";
import { DetailHeader, StatCards } from "@/components/ui/DetailHeader";
import { getTestSections } from "@/lib/teacher-access";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import { ChevronDown, ChevronUp, ChevronsUpDown, Eye, FileText } from "lucide-react";
import TestDetailActions from "./TestDetailActions";
import PrintTestMenu from "./PrintTestMenu";
import EditTestButton from "./EditTestButton";
import RemoveStudentButton from "./RemoveStudentButton";
import AssignDialog from "./AssignDialog";
import { approvalCounts, isFullyApproved } from "../module-approval";
import ReviewModeToggle from "@/components/tests/ReviewModeToggle";
import AnswerVisibilityToggle from "@/components/tests/AnswerVisibilityToggle";
import { formatDateTime, formatShortDateTime } from "@/lib/datetime";
import { getQaClassGroupIds, getQaTestIds, onSide, scopeIds, scopeUsers } from "@/lib/qa";
import { getTranslations } from "next-intl/server";
import {
  loadAnswerVisibilityInputs,
  summarizeAnswerVisibility,
  visibilityKey,
} from "@/lib/answer-visibility";
import { answerVisibilityLabel } from "@/components/tests/answer-visibility-label";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  RowActions,
  RowButton,
  RowMenuSlot,
  TwoLineCell,
} from "@/components/ui/data-table";

async function getTest(id: string, viewerIsQa: boolean) {
  const db = getServiceClient();

  const { data: test, error } = await db
    .from("tests")
    .select(`
      id, test_name, module_id, module_2_id, time_limit_minutes, time_limit_minutes_module_2,
      open_date, due_date,
      show_answers_after_submission, show_explanations_after_submission, allow_retake, status, created_at, updated_at,
      is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, adaptive_threshold,
      desmos_enabled, formula_sheet_url, review_unlocked,
      modules!module_id(module_name, section, module_number, source_name)
    `)
    .eq("id", id)
    .single();

  if (error || !test) return null;

  // module_2_id (non-adaptive two-module path) lives in a separate
  // column with no foreign-key embed alias here, so pull its metadata
  // in a follow-up query. Adaptive tests don't use this column.
  let module2Meta:
    | { module_name: string; section: string; module_number: number | null }
    | null = null;
  if (test.module_2_id) {
    const { data: m2 } = await db
      .from("modules")
      .select("module_name, section, module_number")
      .eq("id", test.module_2_id)
      .maybeSingle();
    module2Meta = (m2 as { module_name: string; section: string; module_number: number | null } | null) ?? null;
  }

  const [{ data: assignment }, { data: submissions }] = await Promise.all([
    db.from("test_assignments").select("teacher_ids, student_ids, class_group_ids").eq("test_id", id).single(),
    db.from("submissions").select("id, status, score, percentage, student_id, submitted_at, session_id, adaptive_track, started_at, correct_count, total_questions").eq("test_id", id),
  ]);

  const teacherIds: string[] = assignment?.teacher_ids ?? [];
  const studentIds: string[] = assignment?.student_ids ?? [];
  const classGroupIds: string[] = assignment?.class_group_ids ?? [];

  const qaGroups = await getQaClassGroupIds();
  const [{ data: teachers }, { data: classGroups }, { data: allTeachers }, { data: allClassGroups }, { data: classMembers }] = await Promise.all([
    teacherIds.length > 0
      ? db.from("users").select("id, display_name, email").in("id", teacherIds)
      : Promise.resolve({ data: [] }),
    classGroupIds.length > 0
      ? db.from("class_groups").select("id, name").in("id", classGroupIds)
      : Promise.resolve({ data: [] }),
    scopeUsers(db.from("users").select("id, display_name, email").eq("role", "teacher"), viewerIsQa).order("display_name"),
    scopeIds(db.from("class_groups").select("id, name, campus, grade"), "id", qaGroups, viewerIsQa).order("name"),
    classGroupIds.length > 0
      ? db.from("class_group_members").select("class_group_id, student_id").in("class_group_id", classGroupIds)
      : Promise.resolve({ data: [] as { class_group_id: string; student_id: string }[] }),
  ]);

  const twoModules = Boolean(test.module_2_id || test.is_adaptive);
  const members = (classMembers ?? []) as { class_group_id: string; student_id: string }[];
  const groupName = new Map(((classGroups ?? []) as { id: string; name: string }[]).map((g) => [g.id, g.name]));

  // Everyone assigned (individually or through a class), plus anyone who
  // still has work on the test after being unassigned.
  const individual = new Set(studentIds);
  const groupsByStudent = new Map<string, string[]>();
  for (const m of members) {
    groupsByStudent.set(m.student_id, [...(groupsByStudent.get(m.student_id) ?? []), m.class_group_id]);
  }
  const allStudentIds = [
    ...new Set([...studentIds, ...groupsByStudent.keys(), ...(submissions ?? []).map((s) => s.student_id as string)]),
  ];
  const { data: studentRows } = allStudentIds.length > 0
    ? await db.from("users").select("id, display_name, email").in("id", allStudentIds)
    : { data: [] as { id: string; display_name: string | null; email: string }[] };

  const students = ((studentRows ?? []) as { id: string; display_name: string | null; email: string }[])
    .map((u) => {
      const subs = (submissions ?? []).filter((s) => s.student_id === u.id);
      const groups = groupsByStudent.get(u.id) ?? [];
      return {
        id: u.id,
        name: u.display_name || u.email,
        email: u.email,
        individual: individual.has(u.id),
        groups: groups.map((g) => groupName.get(g) ?? "Class"),
        progress: studentTestProgress(subs, twoModules),
        submissionCount: subs.length,
        hasGradedSubmission: subs.some((s) => s.status === "Submitted" || s.status === "Late"),
        // Individually assigned students who are also in an assigned class
        // group keep seeing the test after Remove (M-17).
        visibleViaGroup: groups.length > 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const submittedSubs = (submissions ?? []).filter((s) => s.status === "Submitted" || s.status === "Late");

  // Students assigned through a class count too; every student is counted
  // once even though each module is its own submission row.
  const progress = summarizeTestProgress(
    submissions ?? [],
    [...studentIds, ...members.map((m) => m.student_id)],
    twoModules,
  );

  return {
    ...test,
    module2Meta,
    assignment: {
      teacherIds,
      studentIds,
      classGroupIds,
      students,
      teachers: (teachers ?? []) as { id: string; display_name: string | null; email: string }[],
      classGroups: (classGroups ?? []) as { id: string; name: string }[],
      allTeachers: allTeachers ?? [],
      allClassGroups: allClassGroups ?? [],
    },
    stats: {
      total: (submissions ?? []).length,
      submitted: submittedSubs.length,
    },
    progress,
  };
}

export default async function TestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const { id } = await params;
  const { sort } = await searchParams;
  if (!onSide(id, await getQaTestIds(), user.isQa)) notFound();
  const test = await getTest(id, user.isQa);
  if (!test) notFound();

  const db = getServiceClient();
  const section = (await getTestSections(db, [test.id])).get(test.id) ?? null;

  // Effective answer visibility for every student in the Students table
  // (individual + class-assigned + unassigned-with-work) — the same decision
  // their result / review pages enforce (test setting, class review,
  // per-student override, retake safety).
  const [visibilityInputs, tv] = await Promise.all([
    loadAnswerVisibilityInputs(
      db,
      [test.id],
      test.assignment.students.map((st) => st.id),
      new Map([[test.id, {
        show_answers_after_submission: test.show_answers_after_submission,
        show_explanations_after_submission: test.show_explanations_after_submission,
        review_unlocked: test.review_unlocked,
      }]]),
    ),
    getTranslations("answerVisibility"),
  ]);

  // Eligible modules for the Edit modal — same predicate as the create
  // page: every non-rejected question Approved (see module-approval.ts).
  const { data: modulesRaw } = await db
    .from("modules")
    .select(
      "id, module_name, section, module_number, parsing_status, total_questions, questions:questions!module_id(parsing_status)",
    )
    .order("module_name");
  type ModRow = {
    id: string;
    module_name: string;
    section: string;
    module_number: number | null;
    parsing_status: string;
    total_questions: number | null;
    questions: { parsing_status: string }[] | null;
  };
  // Whatever modules this test already uses must remain in the dropdown
  // even if they no longer pass the eligibility filter (e.g. an admin
  // un-approved a Module that's still wired to a published test). Skip
  // and the select falls back to "— None —" and looks broken.
  const currentModuleIds = new Set(
    [
      test.module_id,
      test.module_2_id,
      test.module_1_id,
      test.module_2_easy_id,
      test.module_2_hard_id,
    ].filter((x): x is string => Boolean(x)),
  );
  const eligibleModules = ((modulesRaw ?? []) as ModRow[])
    .map((m) => ({ m, counts: approvalCounts(m.questions) }))
    .filter(({ m, counts }) => currentModuleIds.has(m.id) || isFullyApproved(counts))
    .map(({ m, counts }) => ({
      id: m.id,
      module_name: m.module_name,
      section: m.section,
      module_number: m.module_number,
      total_questions: m.total_questions,
      approved: counts.approved,
      approvalTotal: counts.total,
    }));

  // Adaptive tests have no single tests.module_id, so the join may
  // return null. The summary line below switches to a multi-module
  // label in that case.
  const mod = test.modules as unknown as
    | { module_name: string; section: string; module_number: number | null; source_name: string | null }
    | null;
  const m2 = test.module2Meta;

  const modLabel = (m: { section: string; module_number: number | null }) =>
    `${m.section}${m.module_number ? ` M${m.module_number}` : ""}`;
  const modulesShort = !mod
    ? "Adaptive · M1 + M2 (easy/hard)"
    : !m2
      ? modLabel(mod)
      : m2.section === mod.section
        ? `${mod.section} M${mod.module_number ?? 1} + M${m2.module_number ?? 2}`
        : `${modLabel(mod)} + ${modLabel(m2)}`;

  // Two-module test (non-adaptive with module_2_id, or any adaptive test)
  // shows both modules' limits as "M1 + M2". Module 2 falls back to
  // Module 1's limit when the admin didn't set a separate one.
  const timeLimit = (() => {
    const t1 = test.time_limit_minutes;
    const t2 = test.time_limit_minutes_module_2 ?? t1;
    if (!t1) return "—";
    if (test.is_adaptive || Boolean(test.module_2_id)) return `${t1} + ${t2} min`;
    return `${t1} min`;
  })();

  const { assignment, progress } = test;

  // Score column: SAT estimate per student; header click sorts by it
  // (?sort=score high→low, ?sort=score-asc low→high, unfinished last).
  const scoreOf = new Map(assignment.students.map((st) => [st.id, scoreDisplay(st.progress.modules, section)]));
  const satOf = (sid: string) => scoreOf.get(sid)?.sat ?? null;
  const sortDir = sort === "score" ? -1 : sort === "score-asc" ? 1 : 0;
  const students = sortDir
    ? [...assignment.students].sort((a, b) => {
        const x = satOf(a.id), y = satOf(b.id);
        if (x == null || y == null) return x == null && y == null ? a.name.localeCompare(b.name) : x == null ? 1 : -1;
        return (x - y) * sortDir || a.name.localeCompare(b.name);
      })
    : assignment.students;
  const avgSat = averageSat(assignment.students.map((st) => satOf(st.id)));
  const scoreSortHref = `/admin/tests/${id}?sort=${sort === "score" ? "score-asc" : "score"}`;
  const submissionsHref = `/admin/tests/${test.id}/submissions`;

  const settings: { label: string; value: string }[] = [
    {
      label: "Modules",
      value: mod
        ? [
            `${mod.module_name} · ${modLabel(mod)}${mod.source_name ? ` · ${mod.source_name}` : ""}`,
            m2 ? `${m2.module_name} · ${modLabel(m2)}` : null,
          ]
            .filter(Boolean)
            .join("  +  ")
        : "Adaptive · Module 1 + Module 2 (easy/hard)",
    },
    { label: "Time limit", value: timeLimit },
    { label: "Open date", value: test.open_date ? formatDateTime(test.open_date) : "—" },
    { label: "Due date", value: test.due_date ? formatDateTime(test.due_date) : "—" },
    { label: "Allow retake", value: test.allow_retake ? "Yes" : "No" },
    { label: "Desmos calculator", value: test.desmos_enabled ? "On" : "Off" },
    ...(test.is_adaptive
      ? [{ label: "Adaptive threshold", value: `${test.adaptive_threshold ?? 60}%` }]
      : []),
  ];

  return (
    <div className="space-y-6">
      {/* 1. Header: name, one summary line, Assign (main) · Edit · More */}
      <DetailHeader
        back={{ href: "/admin/tests", label: "Tests" }}
        title={test.test_name}
        badge={<StatusBadge kind="test" status={test.status as TestStatus} />}
        summary={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <SubjectTag section={section} />
            <span>{modulesShort}</span>
            <span aria-hidden>·</span>
            <span>{timeLimit}</span>
            {test.due_date && (
              <>
                <span aria-hidden>·</span>
                <span title={formatDateTime(test.due_date)}>Due {formatShortDateTime(test.due_date)}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
          <AssignDialog
            testId={test.id}
            studentIds={assignment.studentIds}
            classGroupIds={assignment.classGroupIds}
            teacherIds={assignment.teacherIds}
            allClassGroups={assignment.allClassGroups}
            allTeachers={assignment.allTeachers}
          />
          <EditTestButton
            test={{
              id: test.id,
              test_name: test.test_name,
              is_adaptive: Boolean(test.is_adaptive),
              module_id: test.module_id,
              module_2_id: test.module_2_id,
              module_1_id: test.module_1_id,
              module_2_easy_id: test.module_2_easy_id,
              module_2_hard_id: test.module_2_hard_id,
              adaptive_threshold: test.adaptive_threshold,
              time_limit_minutes: test.time_limit_minutes,
              time_limit_minutes_module_2: test.time_limit_minutes_module_2,
              open_date: test.open_date,
              due_date: test.due_date,
              show_answers_after_submission: Boolean(test.show_answers_after_submission),
              allow_retake: Boolean(test.allow_retake),
              desmos_enabled: Boolean(test.desmos_enabled),
            }}
            modules={eligibleModules}
            hasSubmissions={test.stats.total > 0}
          />
          <PrintTestMenu testId={test.id} />
          <TestDetailActions
            testId={test.id}
            testName={test.test_name}
            status={test.status}
            submissionCount={test.stats.total}
            gradedCount={test.stats.submitted}
          />
          </>
        }
      />

      {/* 2. Key numbers */}
      <StatCards
        items={[
          { label: "Submitted", value: `${progress.finished} / ${progress.students}`, detail: "students finished" },
          {
            label: "Avg SAT",
            value: avgSat ?? "—",
            detail: progress.avgScore !== null ? `${progress.avgScore.toFixed(1)}% correct` : undefined,
          },
          {
            label: "Open / Due",
            value: <span className="text-base">{test.due_date ? formatShortDateTime(test.due_date) : "No due date"}</span>,
            detail: test.open_date ? `Opens ${formatShortDateTime(test.open_date)}` : "Open now",
          },
          { label: "Retake", value: <span className="text-base">{test.allow_retake ? "Allowed" : "Not allowed"}</span> },
        ]}
      />

      {/* 3. Students */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="space-y-0.5">
            <h2 className="text-charcoal font-semibold">Students</h2>
            <p className="text-soft-mute text-xs">
              <span className="text-mid-gray font-medium">Teachers:</span>{" "}
              {assignment.teachers.length === 0
                ? "None assigned"
                : assignment.teachers.map((t) => t.display_name || t.email).join(", ")}
              <span className="mx-2">·</span>
              <span className="text-mid-gray font-medium">Classes:</span>{" "}
              {assignment.classGroups.length === 0
                ? "None"
                : assignment.classGroups.map((cg) => cg.name).join(", ")}
            </p>
          </div>
          <Link href={submissionsHref} className="text-warm-coral-text text-sm hover:underline">
            View all submissions →
          </Link>
        </div>
        {assignment.students.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-divider px-5 py-8 text-center text-soft-mute text-sm">
            No students yet. Use <strong className="text-charcoal">Assign</strong> above to add students or a class.
          </p>
        ) : (
          <DataTable>
            <thead>
              <HeadRow>
                <Th kind="main" sticky="left">Student</Th>
                <Th priority="xl">Assigned via</Th>
                <Th>Status</Th>
                <Th aria-sort={sortDir === -1 ? "descending" : sortDir === 1 ? "ascending" : "none"}>
                  <Link href={scoreSortHref} scroll={false} className="inline-flex items-center gap-1 hover:text-charcoal">
                    Score
                    {sortDir === -1 ? <ChevronDown size={12} /> : sortDir === 1 ? <ChevronUp size={12} /> : <ChevronsUpDown size={12} className="opacity-50" />}
                  </Link>
                </Th>
                <Th priority="xl">{tv("column")}</Th>
                <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
              </HeadRow>
            </thead>
            <tbody>
              {students.map((st) => {
                const assignedVia = [st.individual ? "Individual" : null, ...st.groups].filter(Boolean).join(" · ");
                const input = visibilityInputs.get(visibilityKey(test.id, st.id));
                const effective = input ? summarizeAnswerVisibility(input) : null;
                const visLabel = effective ? answerVisibilityLabel(tv, effective) : null;

                // Rule 4: the student's work is the visible action (and the
                // row link); removing them from the test is in ⋯.
                const primary = st.progress.detailSubmissionId
                  ? { label: "View result", icon: <Eye size={13} />, href: `/teacher/tests/${test.id}/results/${st.progress.detailSubmissionId}` }
                  : st.submissionCount > 0
                  ? { label: "Submissions", icon: <FileText size={13} />, href: submissionsHref }
                  : null;

                return (
                  <DataRow
                    key={st.id}
                    href={primary?.href}
                    expandBelow="xl"
                    colSpan={6}
                    details={
                      <>
                        <DetailItem label="Assigned via" priority="xl">{assignedVia || "Not assigned (has work)"}</DetailItem>
                        <DetailItem label={tv("column")} priority="xl">
                          {visLabel ?? "—"}
                        </DetailItem>
                      </>
                    }
                  >
                    <Td kind="main" sticky="left">
                      <TwoLineCell
                        main={st.name}
                        detail={st.email !== st.name ? st.email : undefined}
                        mainClassName="font-medium text-charcoal"
                      />
                    </Td>
                    <Td priority="xl" className="text-mid-gray">
                      {assignedVia || (
                        <span className="italic text-soft-mute">Not assigned (has work)</span>
                      )}
                    </Td>
                    <Td>
                      <StatusBadge
                        kind="attempt"
                        status={st.progress.status}
                        module={st.progress.currentModule ? { n: st.progress.currentModule, of: st.progress.moduleCount } : null}
                      />
                    </Td>
                    <Td>
                      <ScoreCell score={scoreOf.get(st.id) ?? null} />
                    </Td>
                    <Td priority="xl">
                      {effective ? (
                        // One line: dot + one word; the source is in the hover.
                        <span title={visLabel ?? undefined} className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
                          <span
                            aria-hidden
                            className={effective.answers ? "h-2 w-2 shrink-0 rounded-full bg-status-success" : "h-2 w-2 shrink-0 rounded-full bg-soft-mute"}
                          />
                          <span aria-hidden className={effective.answers ? "text-charcoal" : "text-soft-mute"}>
                            {effective.answers ? tv("visible") : tv("hidden")}
                          </span>
                          <span className="sr-only">{visLabel}</span>
                        </span>
                      ) : (
                        <span className="text-soft-mute text-xs">—</span>
                      )}
                    </Td>
                    <Td kind="actions" sticky="right">
                      <RowActions>
                      <ExpandToggle label={`More about ${st.name}`} />
                      {primary && <RowButton label={primary.label} icon={primary.icon} href={primary.href} />}
                      {st.individual ? (
                        <RemoveStudentButton
                          testId={test.id}
                          studentId={st.id}
                          studentName={st.name}
                          submissionCount={st.submissionCount}
                          hasGradedSubmission={st.hasGradedSubmission}
                          visibleViaGroup={st.visibleViaGroup}
                        />
                      ) : (
                        <RowMenuSlot />
                      )}
                      </RowActions>
                    </Td>
                  </DataRow>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </section>

      {/* 4. Answers & review */}
      <div className="bg-surface border border-divider rounded-2xl p-5 space-y-4">
        <h2 className="text-charcoal font-semibold">Answers &amp; review</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 md:gap-0 md:divide-x divide-divider">
          <div className="md:pr-5">
            <AnswerVisibilityToggle
              compact
              testId={test.id}
              initialShowAnswers={Boolean(test.show_answers_after_submission)}
              initialShowExplanations={
                (test as { show_explanations_after_submission?: boolean }).show_explanations_after_submission ?? true
              }
            />
          </div>
          <div className="md:pl-5 border-t border-divider pt-4 md:border-t-0 md:pt-0">
            <ReviewModeToggle compact testId={test.id} initialUnlocked={Boolean(test.review_unlocked)} />
          </div>
        </div>
      </div>

      {/* 5. Test settings */}
      <details className="group bg-surface border border-divider rounded-2xl">
        <summary className="flex items-center justify-between gap-3 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          <span className="text-charcoal font-semibold">Test settings</span>
          <span className="flex items-center gap-1 text-soft-mute text-xs">
            Use Edit to change
            <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 px-5 pb-5 text-sm">
          {settings.map(({ label, value }) => (
            <div key={label} className={clsx(label === "Modules" && "sm:col-span-2")}>
              <dt className="text-soft-mute text-xs">{label}</dt>
              <dd className="text-charcoal font-medium break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
