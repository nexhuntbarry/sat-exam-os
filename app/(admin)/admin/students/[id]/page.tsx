import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";
import { clsx } from "clsx";
import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, isQaEmail, onSide, scopeIds } from "@/lib/qa";
import { getStudentAssignments } from "@/lib/student-exam";
import { studentTestProgress } from "@/lib/test-progress";
import { getTestSections } from "@/lib/teacher-access";
import { scaleSectionScore } from "@/lib/scoring";
import { scoreDisplay, type ScoreModule } from "@/lib/score-display";
import { StatusBadge, studentStatusLabel } from "@/components/ui/StatusBadge";
import EditStudentButton from "./EditStudentButton";
import StudentActionsMenu from "./StudentActionsMenu";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import ProgressReport from "@/components/analytics/ProgressReport";
import ScoreProgressChart from "@/components/analytics/ScoreProgressChart";
import PerTestBreakdown from "@/components/analytics/PerTestBreakdown";
import { getStudentBreakdownRows, getStudentProgressOccasions } from "@/lib/student-analytics";
import {
  loadAnswerVisibilityInputs,
  summarizeAnswerVisibility,
  visibilityKey,
} from "@/lib/answer-visibility";
import TestsTable, {
  type TestRow,
  type TestRowStatus,
  type VisibilityRowData,
} from "@/components/tests/TestsTable";

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
      `id, test_id, student_id, status, score, correct_count, total_questions, percentage,
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
  student_id: string;
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

type TestMeta = {
  id: string;
  test_name: string;
  due_date: string | null;
  is_adaptive: boolean | null;
  module_id: string | null;
  module_2_id: string | null;
  module_1_id: string | null;
  module_2_easy_id: string | null;
  module_2_hard_id: string | null;
};

type SessionGroupModule = {
  label: string;
  graded: boolean;
  submissionId: string;
  correct: number;
  total: number;
  percentage: number | null;
  scaledScore: number | null;
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
  /** Earliest started_at of the attempt's rows. */
  startedAt: string | null;
  attemptNumber: number | null;
  detailSubmissionId: string;
  isMultiModule: boolean;
  modules: SessionGroupModule[];
  moduleNames: { label: string; name: string }[];
  /** Single-row attempts: the row's adaptive_track (null = legacy one-module attempt). */
  track: string | null;
};

const MODULE_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
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

  const toModuleView = (r: SubmissionRow): SessionGroupModule => ({
    label: MODULE_LABEL[r.adaptive_track ?? ""] ?? "Module",
    graded: r.status === "Submitted" || r.status === "Late",
    submissionId: r.id,
    correct: r.correct_count ?? 0,
    total: r.total_questions ?? 0,
    percentage: r.percentage != null ? Number(r.percentage) : null,
    scaledScore:
      r.scaled_score ??
      (r.percentage != null ? scaleSectionScore(Number(r.percentage)) : null),
  });

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
    startedAt: r.started_at,
    attemptNumber: r.attempt_number,
    detailSubmissionId: r.id,
    isMultiModule: false,
    modules: [],
    moduleNames: [],
    track: r.adaptive_track,
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
      startedAt:
        sorted
          .map((r) => r.started_at)
          .filter((d): d is string => !!d)
          .sort()[0] ?? null,
      attemptNumber: sorted[0].attempt_number,
      // Detail page link routes to the Module 2 (last) submission so
      // the result view can stitch both modules via session_id.
      detailSubmissionId: sorted[sorted.length - 1].id,
      isMultiModule: true,
      modules: sorted.map(toModuleView),
      track: null,
      moduleNames: sorted
        .filter((r) => r.modules?.module_name)
        .map((r, i) => ({ label: `M${i + 1}`, name: r.modules!.module_name })),
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


export default async function AdminStudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [student, me] = await Promise.all([getStudent(id), getCurrentUser()]);
  if (!student || isQaEmail(student.email) !== (me?.isQa ?? false)) notFound();

  const submissions = (await getStudentSubmissions(id)) as unknown as SubmissionRow[];
  const profile = Array.isArray(student.student_profiles)
    ? student.student_profiles[0] ?? null
    : student.student_profiles ?? null;

  const groups = buildSessionGroups(submissions);

  // Every test assigned to the student (directly or via a class group,
  // same resolution as the student's own My Tests), on the viewer's QA side.
  const db = getServiceClient();
  const [assignments, qaTests, qaClassGroups] = await Promise.all([
    getStudentAssignments(db, id),
    getQaTestIds(),
    getQaClassGroupIds(),
  ]);
  for (const testId of Array.from(assignments.keys())) {
    if (!onSide(testId, qaTests, me?.isQa ?? false)) assignments.delete(testId);
  }
  const subsByTest = new Map<string, SubmissionRow[]>();
  for (const s of submissions) {
    subsByTest.set(s.test_id, [...(subsByTest.get(s.test_id) ?? []), s]);
  }
  const allTestIds = Array.from(new Set([...assignments.keys(), ...subsByTest.keys()]));
  const classGroupIds = Array.from(
    new Set(Array.from(assignments.values()).flatMap((a) => a.classGroupIds)),
  );
  const [{ data: testMeta }, sectionOf, { data: classGroups }] = await Promise.all([
    allTestIds.length > 0
      ? db
          .from("tests")
          .select("id, test_name, due_date, is_adaptive, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id")
          .in("id", allTestIds)
      : Promise.resolve({ data: [] as TestMeta[] }),
    getTestSections(db, allTestIds),
    classGroupIds.length > 0
      ? db.from("class_groups").select("id, name").in("id", classGroupIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  const testById = new Map(((testMeta ?? []) as TestMeta[]).map((t) => [t.id, t]));

  // Class membership = class_group_members, the same source the class page's
  // Members list and the Students list use (student_profiles.class_group is a
  // legacy free-text label and is not kept in sync). Plus the pickers for the
  // ⋯ "Add to class" / "Assign test" actions, scoped to the viewer's QA side
  // like the Students page and /api/admin/tests?list=1.
  const viewerIsQa = me?.isQa ?? false;
  const [{ data: memberRows }, { data: allClassGroups }, { data: pickerTests }] = await Promise.all([
    db
      .from("class_group_members")
      .select("class_group_id, class_groups(id, name)")
      .eq("student_id", id),
    scopeIds(db.from("class_groups").select("id, name, campus, grade"), "id", qaClassGroups, viewerIsQa).order("name"),
    scopeIds(db.from("tests").select("id, test_name, status, modules!module_id(section)"), "id", qaTests, viewerIsQa)
      .order("created_at", { ascending: false }),
  ]);
  const memberships = (memberRows ?? [])
    .map((m) => {
      const cg = m.class_groups as unknown as { id: string; name: string } | { id: string; name: string }[] | null;
      return Array.isArray(cg) ? cg[0] ?? null : cg;
    })
    .filter((cg): cg is { id: string; name: string } => !!cg && onSide(cg.id, qaClassGroups, viewerIsQa))
    .sort((a, b) => a.name.localeCompare(b.name));
  const memberOf = new Set(memberships.map((m) => m.id));
  const classPickerItems = (allClassGroups ?? []).map((cg) => ({
    id: cg.id as string,
    label: cg.name as string,
    meta: [cg.campus, cg.grade && `Grade ${cg.grade}`].filter(Boolean).join(" · ") || undefined,
    alreadyIn: memberOf.has(cg.id as string),
  }));
  const testPickerItems = (pickerTests ?? []).map((t) => {
    const mod = t.modules as unknown as { section?: string } | { section?: string }[] | null;
    const section = (Array.isArray(mod) ? mod[0]?.section : mod?.section) ?? null;
    return {
      id: t.id as string,
      label: t.test_name as string,
      meta: [section, t.status].filter(Boolean).join(" · ") || undefined,
      alreadyIn: assignments.has(t.id as string),
    };
  });
  // Full module names for the Test column ("M1: [Test #25] … Module 1").
  const moduleSlots = (t: TestMeta | undefined): { label: string; id: string | null }[] =>
    !t
      ? []
      : t.is_adaptive
      ? [
          { label: "M1", id: t.module_1_id },
          { label: "M2 Easy", id: t.module_2_easy_id },
          { label: "M2 Hard", id: t.module_2_hard_id },
        ]
      : [
          { label: "M1", id: t.module_id },
          { label: "M2", id: t.module_2_id },
        ];
  const moduleIds = Array.from(
    new Set(
      Array.from(testById.values())
        .flatMap((t) => moduleSlots(t).map((m) => m.id))
        .filter((x): x is string => Boolean(x)),
    ),
  );
  const { data: moduleRows } =
    moduleIds.length > 0
      ? await db.from("modules").select("id, module_name").in("id", moduleIds)
      : { data: [] as { id: string; module_name: string }[] };
  const moduleName = new Map((moduleRows ?? []).map((m) => [m.id as string, m.module_name as string]));
  const moduleNamesOf = (testId: string) =>
    moduleSlots(testById.get(testId))
      .filter((m) => m.id && moduleName.has(m.id))
      .map((m) => ({ label: m.label, name: moduleName.get(m.id!)! }));
  const className = new Map((classGroups ?? []).map((c) => [c.id as string, c.name as string]));
  const progressOf = new Map(
    allTestIds.map((testId) => {
      const t = testById.get(testId);
      const twoModules = Boolean(t?.module_2_id || t?.is_adaptive);
      return [testId, studentTestProgress(subsByTest.get(testId) ?? [], twoModules)];
    }),
  );
  // Latest attempt per test carries the test-level progress status.
  const latestGroupKey = new Map<string, string>();
  const latestStart = new Map<string, string>();
  for (const g of groups) {
    const cur = latestStart.get(g.testId);
    if (!latestGroupKey.has(g.testId) || (g.startedAt ?? "") > (cur ?? "")) {
      latestGroupKey.set(g.testId, g.key);
      latestStart.set(g.testId, g.startedAt ?? "");
    }
  }

  // Per-test answer visibility for this student (same server-side decision
  // the student's pages enforce) + who last changed the override.
  const testIds = Array.from(new Set(groups.map((g) => g.testId)));
  const visibilityInputs = await loadAnswerVisibilityInputs(db, testIds, [id]);
  const updaterIds = Array.from(
    new Set(
      Array.from(visibilityInputs.values())
        .map((v) => v.override?.updated_by)
        .filter((x): x is string => Boolean(x)),
    ),
  );
  const { data: updaters } =
    updaterIds.length > 0
      ? await db.from("users").select("id, display_name, email").in("id", updaterIds)
      : { data: [] as { id: string; display_name: string | null; email: string }[] };
  const updaterName = new Map(
    (updaters ?? []).map((u) => [u.id as string, (u.display_name || u.email) as string]),
  );
  // The picker sits on the newest row per test; older attempts of the same
  // test just show the effective state.
  const controlRowKey = new Map<string, string>();
  for (const g of groups) if (!controlRowKey.has(g.testId)) controlRowKey.set(g.testId, g.key);
  const breakdownRows = await getStudentBreakdownRows(id);
  const occasions = await getStudentProgressOccasions(id);
  const assignedCount = assignments.size;
  const completedCount = Array.from(progressOf.values()).filter(
    (p) => p.status === "Submitted",
  ).length;


  const assignmentFields = (testId: string) => {
    const a = assignments.get(testId);
    const t = testById.get(testId);
    return {
      assignedDirect: a?.direct ?? false,
      assignedClasses: (a?.classGroupIds ?? []).map((cg) => className.get(cg) ?? "Class"),
      assignedAt: a?.assignedAt ?? null,
      dueDate: (t?.due_date as string | null | undefined) ?? null,
      moduleCount: progressOf.get(testId)?.moduleCount ?? 1,
    };
  };

  // Build serializable rows for TestsTable: one per attempt taken, plus one
  // per assigned test the student hasn't started.
  // One score display everywhere (lib/score-display): SAT once every module
  // is in, per-module counts, unfinished modules as "—".
  const scoreOfGroup = (g: SessionGroup) => {
    const count = g.track ? progressOf.get(g.testId)?.moduleCount ?? 1 : 1;
    const mods: ScoreModule[] = g.isMultiModule
      ? g.modules.map((m, i) => ({ number: i + 1, graded: m.graded, correct: m.correct, total: m.total }))
      : [{ number: 1, graded: g.status !== "In Progress", correct: g.correct, total: g.total }];
    for (let n = mods.length + 1; n <= count; n++) mods.push({ number: n, graded: false, correct: null, total: null });
    return scoreDisplay(mods, g.section);
  };
  const attemptRows: TestRow[] = groups.map((g) => {
    const input = visibilityInputs.get(visibilityKey(g.testId, id));
    const isControlRow = controlRowKey.get(g.testId) === g.key;
    let visibility: VisibilityRowData | null = null;
    if (input) {
      const effective = summarizeAnswerVisibility(input);
      const ov = input.override;
      visibility = {
        isControlRow,
        initialMode: ov?.mode ?? "follow",
        initialShowExplanations: ov?.show_explanations ?? true,
        effectiveAnswers: effective.answers,
        effectiveExplanations: effective.explanations,
        effectiveSource: effective.source,
        updatedBy: ov?.updated_by ?? null,
        updatedAt: ov?.updated_at ?? null,
        updaterName:
          (ov?.updated_by && updaterName.get(ov.updated_by)) || null,
      };
    }
    const progress = progressOf.get(g.testId);
    const isLatest = latestGroupKey.get(g.testId) === g.key;
    let status: TestRowStatus =
      g.status === "In Progress" ? "In progress" : g.status === "Late" ? "Late" : "Submitted";
    if (isLatest && progress && progress.status !== "Submitted") status = progress.status;
    return {
      key: g.key,
      testId: g.testId,
      testName: g.testName,
      section: g.section,
      status,
      currentModule: isLatest && status === "In progress" ? progress?.currentModule ?? null : null,
      ...assignmentFields(g.testId),
      correct: g.correct,
      total: g.total,
      percentage: g.percentage,
      scaledScore: g.scaledScore,
      timeSeconds: g.timeSeconds,
      submittedAt: g.submittedAt,
      attemptNumber: g.attemptNumber,
      detailSubmissionId: g.detailSubmissionId,
      isMultiModule: g.isMultiModule,
      // An adaptive attempt lists the Module 2 the student actually got.
      moduleNames:
        g.isMultiModule && g.moduleNames.length > 1 ? g.moduleNames : moduleNamesOf(g.testId),
      modules: g.modules.map((m) => ({
        label: m.label,
        submissionId: m.submissionId,
        correct: m.correct,
        total: m.total,
        percentage: m.percentage,
      })),
      visibility,
      score: scoreOfGroup(g),
      removable: false,
    };
  });
  const notStartedRows: TestRow[] = Array.from(assignments.values())
    .filter((a) => !subsByTest.has(a.testId))
    .map((a) => ({
      key: `assigned-${a.testId}`,
      testId: a.testId,
      testName: (testById.get(a.testId)?.test_name as string | undefined) ?? "—",
      section: sectionOf.get(a.testId) ?? null,
      status: "Not started" as const,
      currentModule: null,
      ...assignmentFields(a.testId),
      correct: 0,
      total: 0,
      percentage: null,
      scaledScore: null,
      timeSeconds: 0,
      submittedAt: null,
      attemptNumber: null,
      detailSubmissionId: null,
      isMultiModule: false,
      modules: [],
      moduleNames: moduleNamesOf(a.testId),
      visibility: null,
      score: null,
      // Only an individual assignment can be undone per student; a class
      // assignment would need the whole class unassigned.
      removable: a.direct && a.classGroupIds.length === 0,
    }));
  // Not started / in progress first (soonest due first), then finished
  // attempts, most recent first.
  const isOpen = (r: TestRow) => r.status === "Not started" || r.status === "In progress";
  const testRows: TestRow[] = [
    ...[...notStartedRows, ...attemptRows.filter(isOpen)].sort(
      (a, b) =>
        (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
        a.testName.localeCompare(b.testName),
    ),
    ...attemptRows
      .filter((r) => !isOpen(r))
      .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "")),
  ];

  // Latest finished section scores (groups are sorted by submittedAt desc;
  // an attempt still in progress has no SAT score yet).
  const latestMathScore =
    groups.map((g) => (g.section === "Math" ? scoreOfGroup(g)?.sat : null)).find((x) => x != null) ?? null;
  const latestRWScore =
    groups.map((g) => (g.section === "Reading & Writing" ? scoreOfGroup(g)?.sat : null)).find((x) => x != null) ?? null;
  const estimatedTotal =
    latestMathScore != null && latestRWScore != null
      ? latestMathScore + latestRWScore
      : null;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
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
        <StatusBadge kind="student" status={studentStatusLabel(student.account_status)} />
        <EditStudentButton
          student={{
            id: student.id,
            display_name: student.display_name,
            email: student.email,
            grade: profile?.grade ?? null,
            school: profile?.school ?? null,
            campus: profile?.campus ?? null,
            target_score: profile?.target_score ?? null,
            current_level: profile?.current_level ?? null,
            parent_name: profile?.parent_name ?? null,
            parent_email: profile?.parent_email ?? null,
            parent_phone: profile?.parent_phone ?? null,
            notes: profile?.notes ?? null,
          }}
          classNames={memberships.map((m) => m.name)}
        />
        {occasions.length > 0 && (
          <Link href={`/report?student=${student.id}`} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-divider text-sm font-medium text-charcoal hover:bg-light-bg transition-colors">
            Download PDF report
          </Link>
        )}
        <StudentActionsMenu
          studentId={student.id}
          studentName={student.display_name ?? student.email}
          email={student.email}
          status={student.account_status}
          classItems={classPickerItems}
          testItems={testPickerItems}
        />
      </div>

      {/* Profile card */}
      <div className="bg-surface border border-divider rounded-2xl p-6 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        {[
          ["Grade", profile?.grade ?? "—"],
          ["School", profile?.school ?? "—"],
          ["Campus", profile?.campus ?? "—"],
          [
            memberships.length > 1 ? "Classes" : "Class group",
            memberships.length === 0
              ? "—"
              : memberships.map((m, i) => (
                  <span key={m.id}>
                    {i > 0 && ", "}
                    <Link href={`/admin/classes/${m.id}`} className="hover:text-warm-coral transition-colors">
                      {m.name}
                    </Link>
                  </span>
                )),
          ],
          ["Target score", profile?.target_score?.toString() ?? "—"],
          ["Level", profile?.current_level ?? "—"],
          ["Parent", profile?.parent_name ?? "—"],
          ["Parent contact", profile?.parent_email ?? profile?.parent_phone ?? "—"],
        ].map(([label, value]) => (
          <div key={label as string}>
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

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <p className="text-soft-mute text-xs">Latest Math</p>
          <p className="text-3xl font-bold text-charcoal mt-1">
            {latestMathScore ?? "—"}
          </p>
        </div>
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <p className="text-soft-mute text-xs">Latest R&amp;W</p>
          <p className="text-3xl font-bold text-charcoal mt-1">
            {latestRWScore ?? "—"}
          </p>
        </div>
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <p className="text-soft-mute text-xs">Estimated Total</p>
          <p className="text-3xl font-bold text-charcoal mt-1">
            {estimatedTotal ?? "—"}
          </p>
        </div>
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <p className="text-soft-mute text-xs">Tests</p>
          <p className="text-charcoal mt-1 whitespace-nowrap">
            <span className="text-xs text-soft-mute">Assigned</span>{" "}
            <span className="text-3xl font-bold">{assignedCount}</span>
          </p>
          <p className="text-charcoal whitespace-nowrap">
            <span className="text-xs text-soft-mute">Completed</span>{" "}
            <span className="text-xl font-bold">{completedCount}</span>
          </p>
        </div>
      </div>

      {/* Submissions table */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-divider">
          <h2 className="text-charcoal font-semibold">Tests</h2>
        </div>
        <TestsTable
          rows={testRows}
          studentId={id}
          studentName={student.display_name ?? student.email}
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
    </div>
  );
}
