import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";
import { clsx } from "clsx";
import { getServiceClient } from "@/lib/supabase";
import { childTestIds, hideChildTests } from "@/lib/full-length";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, isQaEmail, onSide, scopeIds } from "@/lib/qa";
import { getStudentAssignments } from "@/lib/student-exam";
import { studentTestProgress } from "@/lib/test-progress";
import { isModule2NotTaken, M2_NOT_TAKEN_COLUMN } from "@/lib/module2-not-taken";
import { getTestSections } from "@/lib/teacher-access";
import { scaleSectionScore } from "@/lib/scoring";
import { isCustomRows, scoreDisplay, type ScoreModule } from "@/lib/score-display";
import { fullLengthLinksOrNone } from "@/lib/full-length";
import { profileTimeMultiplier } from "@/lib/full-length-admin";
import {
  flBadge,
  flFinished,
  flModuleCells,
  groupFullLengthAttempts,
  lastSubmittedAt,
  loadFlAttemptMeta,
  scoreGroups,
} from "@/lib/full-length-score";
import { StatusBadge, studentStatusLabel } from "@/components/ui/StatusBadge";
import EditStudentButton from "./EditStudentButton";
import StudentActionsMenu from "./StudentActionsMenu";
import StudentTestsActions, { type ClassChoice } from "./StudentTestsActions";
import CheckProfileBadge from "./CheckProfileBadge";
import StudentInsights from "@/components/analytics/StudentInsights";
import RecentPracticeTests from "@/components/analytics/RecentPracticeTests";
import type { RecentScoreItem } from "@/lib/recent-scores";
import ScoreProgressChart from "@/components/analytics/ScoreProgressChart";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import StudentConclusions from "@/components/analytics/StudentConclusions";
import StudentTabs from "@/components/students/StudentTabs";
import StudentProfileCard from "@/components/students/StudentProfileCard";
import type { Occasion } from "@/lib/score-analysis";
import { getStudentProgressOccasions } from "@/lib/student-analytics";
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
  metadata?: Record<string, unknown> | null;
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
      `id, email, display_name, account_status, created_at, clerk_user_id, metadata,
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
       scaled_score, scaled_section, session_id, adaptive_track, module_id, ${M2_NOT_TAKEN_COLUMN},
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
  module_id: string | null;
  m2_not_taken?: unknown;
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
  /** Module 2 closed without being opened (lib/module2-not-taken). */
  notTaken: boolean;
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
    graded: (r.status === "Submitted" || r.status === "Late") && !isModule2NotTaken(r),
    notTaken: isModule2NotTaken(r),
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
    // A Module 2 closed without being opened is not a result: the attempt
    // is Incomplete, counted on Module 1 alone, with no SAT score.
    const incomplete = sorted.some(isModule2NotTaken);
    const counted = sorted.filter((r) => !isModule2NotTaken(r));
    const correct = counted.reduce((s, r) => s + (r.correct_count ?? 0), 0);
    const total = counted.reduce((s, r) => s + (r.total_questions ?? 0), 0);
    const time = counted.reduce((s, r) => s + (r.time_spent_seconds ?? 0), 0);
    const pct =
      total > 0 ? Math.round((correct / total) * 100 * 10) / 10 : null;
    const scaled = pct != null && !incomplete ? scaleSectionScore(pct) : null;
    // Headline status: if any row is still In Progress, the attempt is
    // mid-flight. Otherwise Late if any Late, else Submitted.
    const statuses = sorted.map((r) => r.status);
    const status = incomplete
      ? "Incomplete"
      : statuses.includes("In Progress")
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

  const allSubmissions = (await getStudentSubmissions(id)) as unknown as SubmissionRow[];
  const profile = Array.isArray(student.student_profiles)
    ? student.student_profiles[0] ?? null
    : student.student_profiles ?? null;

  // Full-length SAT section rows: one history row per full-length attempt
  // under the parent (total, both sections); everything else as before.
  const flLinks = await fullLengthLinksOrNone(getServiceClient());
  const { attempts: flGroups, rest: submissions } = groupFullLengthAttempts(allSubmissions, flLinks);
  const flParentIds = Array.from(new Set(flGroups.map((g) => g.parentId)));
  const flScored = scoreGroups(flGroups, await loadFlAttemptMeta(getServiceClient(), flParentIds, id));

  const groups = buildSessionGroups(submissions);
  // Custom tests (stage modules): "Estimated" SAT, no "in review" notes.
  const customTestIds = new Set(submissions.filter((s) => isCustomRows([s])).map((s) => s.test_id));

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
  const allTestIds = Array.from(new Set([...assignments.keys(), ...subsByTest.keys(), ...flParentIds]));
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
    hideChildTests(
      scopeIds(db.from("tests").select("id, test_name, status, modules!module_id(section)"), "id", qaTests, viewerIsQa),
      await childTestIds(db),
    ).order("created_at", { ascending: false }),
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
  // Tests card "Add to class": how many of each class's tests (not Closed,
  // on this side) the student would newly get.
  const openPickerIds = (pickerTests ?? []).filter((t) => t.status !== "Closed").map((t) => t.id as string);
  const { data: pickerAssignments } = openPickerIds.length > 0
    ? await db.from("test_assignments").select("test_id, class_group_ids").in("test_id", openPickerIds)
    : { data: [] as { test_id: string; class_group_ids: string[] | null }[] };
  const newTestsByClass = new Map<string, number>();
  for (const a of pickerAssignments ?? []) {
    if (assignments.has(a.test_id as string)) continue;
    for (const cg of ((a.class_group_ids ?? []) as string[])) newTestsByClass.set(cg, (newTestsByClass.get(cg) ?? 0) + 1);
  }
  const classChoices: ClassChoice[] = classPickerItems.map((c) => ({
    id: c.id,
    name: c.label,
    meta: c.meta,
    alreadyIn: Boolean(c.alreadyIn),
    newTests: newTestsByClass.get(c.id) ?? 0,
  }));
  const testsActions = (compact: boolean) => (
    <StudentTestsActions
      studentId={student.id}
      studentName={student.display_name ?? student.email}
      alreadyAssigned={Array.from(assignments.keys())}
      classes={classChoices}
      suspended={student.account_status === "suspended"}
      compact={compact}
    />
  );
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
  const testIds = Array.from(new Set([...groups.map((g) => g.testId), ...flParentIds]));
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
  const [occasions, tt] = await Promise.all([
    getStudentProgressOccasions(id, { habits: true }),
    getTranslations("studentTabs"),
  ]);
  const assignedCount = assignments.size;
  // A full-length SAT counts as completed when its latest attempt has a total.
  const flLatest = new Map<string, (typeof flScored)[number]>();
  for (const g of flScored) {
    const cur = flLatest.get(g.parentId);
    if (!cur || g.attemptNumber > cur.attemptNumber) flLatest.set(g.parentId, g);
  }
  const completedCount =
    Array.from(progressOf.entries()).filter(([testId, p]) => !flLatest.has(testId) && p.status === "Submitted").length +
    Array.from(flLatest.values()).filter((g) => flFinished(g.score)).length;


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
      ? g.modules.map((m, i) => ({ number: i + 1, graded: m.graded, correct: m.correct, total: m.total, notTaken: m.notTaken }))
      : [{ number: 1, graded: g.status !== "In Progress", correct: g.correct, total: g.total }];
    for (let n = mods.length + 1; n <= count; n++) mods.push({ number: n, graded: false, correct: null, total: null });
    return scoreDisplay(mods, g.section, { custom: customTestIds.has(g.testId) });
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
      g.status === "In Progress"
        ? "In progress"
        : g.status === "Incomplete"
          ? "Incomplete"
          : g.status === "Late"
            ? "Late"
            : "Submitted";
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
        notTaken: m.notTaken,
      })),
      visibility,
      score: scoreOfGroup(g),
      removable: false,
    };
  });
  // Full-length SAT attempts (the visibility picker sits on the newest attempt).
  const flControlKey = new Map<string, string>();
  for (const g of [...flScored].sort((a, b) => b.attemptNumber - a.attemptNumber)) {
    if (!flControlKey.has(g.parentId)) flControlKey.set(g.parentId, g.key);
  }
  const flRows: TestRow[] = flScored.map((g) => {
    const input = visibilityInputs.get(visibilityKey(g.parentId, id));
    let visibility: VisibilityRowData | null = null;
    if (input) {
      const effective = summarizeAnswerVisibility(input);
      const ov = input.override;
      visibility = {
        isControlRow: flControlKey.get(g.parentId) === g.key,
        initialMode: ov?.mode ?? "follow",
        initialShowExplanations: ov?.show_explanations ?? true,
        effectiveAnswers: effective.answers,
        effectiveExplanations: effective.explanations,
        effectiveSource: effective.source,
        updatedBy: ov?.updated_by ?? null,
        updatedAt: ov?.updated_at ?? null,
        updaterName: (ov?.updated_by && updaterName.get(ov.updated_by)) || null,
      };
    }
    const rows = [...g.rw, ...g.math];
    const graded = rows.filter((r) => (r.status === "Submitted" || r.status === "Late") && !isModule2NotTaken(r));
    const correct = graded.reduce((n, r) => n + (r.correct_count ?? 0), 0);
    const total = graded.reduce((n, r) => n + (r.total_questions ?? 0), 0);
    const [rwM1, rwM2] = flModuleCells(g.score.rw);
    const [mathM1, mathM2] = flModuleCells(g.score.math);
    const status: TestRowStatus = flFinished(g.score)
      ? (g.score.status as TestRowStatus)
      : g.score.status === "Incomplete"
      ? "Incomplete"
      : g.score.status.startsWith("Closed")
      ? "Late"
      : "In progress";
    const sorted = (list: SubmissionRow[]) =>
      [...list].sort((a, b) => (a.adaptive_track === "module_1" ? 0 : 1) - (b.adaptive_track === "module_1" ? 0 : 1));
    return {
      key: `fl:${g.key}`,
      testId: g.parentId,
      testName: (testById.get(g.parentId)?.test_name as string | undefined) ?? "—",
      section: null,
      status,
      currentModule: null,
      ...assignmentFields(g.parentId),
      moduleCount: 4,
      correct,
      total,
      percentage: g.score.score?.pct ?? null,
      scaledScore: g.score.total,
      timeSeconds: rows.reduce((n, r) => n + (r.time_spent_seconds ?? 0), 0),
      submittedAt: rows.map((r) => r.submitted_at).filter((d): d is string => !!d).sort().pop() ?? null,
      attemptNumber: g.attemptNumber,
      detailSubmissionId: graded[graded.length - 1]?.id ?? null,
      detailHref: `/teacher/tests/${g.parentId}/results`,
      statusLabel: flBadge(g.score).label,
      isMultiModule: true,
      moduleNames: [
        { label: "Full-length SAT", name: `R&W M1 ${rwM1 || "—"} · M2 ${rwM2 || "—"}${g.score.rwTrack ? ` (${g.score.rwTrack})` : ""} · Math M1 ${mathM1 || "—"} · M2 ${mathM2 || "—"}${g.score.mathTrack ? ` (${g.score.mathTrack})` : ""}` },
      ],
      modules: [
        ...sorted(g.rw).map((r) => ({ prefix: "R&W", r })),
        ...sorted(g.math).map((r) => ({ prefix: "Math", r })),
      ].map(({ prefix, r }) => ({
        label: `${prefix} ${MODULE_LABEL[r.adaptive_track ?? ""] ?? "Module"}`,
        submissionId: r.id,
        correct: r.correct_count ?? 0,
        total: r.total_questions ?? 0,
        percentage: r.percentage != null ? Number(r.percentage) : null,
        notTaken: isModule2NotTaken(r),
      })),
      visibility,
      score: g.score.score,
      removable: false,
    };
  });
  attemptRows.push(...flRows);

  const notStartedRows: TestRow[] = Array.from(assignments.values())
    .filter((a) => !subsByTest.has(a.testId) && !flLatest.has(a.testId))
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
  // Prefer the latest finished full-length SAT total (a real one-sitting
  // score) over adding up the latest section tests.
  const latestFl = flScored
    .filter((g) => flFinished(g.score) && g.score.total != null)
    .map((g) => ({ total: g.score.total!, at: [...g.rw, ...g.math].map((r) => r.submitted_at ?? "").sort().pop() ?? "" }))
    .sort((a, b) => b.at.localeCompare(a.at))[0];

  // "Recent practice tests": finished attempts only, with the same scores
  // as the Tests table (section tests: scoreOfGroup; full-length: its total).
  const recentItems: RecentScoreItem[] = [
    ...groups
      .filter((g) => g.status === "Submitted" || g.status === "Late")
      .map((g) => ({ g, score: scoreOfGroup(g) }))
      .filter(({ g, score }) => score?.pct != null && g.submittedAt)
      .map(({ g, score }) => ({
        key: g.key,
        date: g.submittedAt!,
        testName: g.testName,
        href: `/teacher/tests/${g.testId}/results/${g.detailSubmissionId}`,
        kind: "section" as const,
        sections: [
          {
            section: g.section ?? sectionOf.get(g.testId) ?? "",
            sat: score!.sat,
            modules: g.isMultiModule
              ? g.modules.filter((m) => !m.notTaken).map((m) => `${m.correct}/${m.total}`)
              : [`${g.correct}/${g.total}`],
          },
        ],
        total: null,
        estimated: score!.estimated,
      })),
    ...flScored
      .filter((g) => flFinished(g.score) && lastSubmittedAt([...g.rw, ...g.math]))
      .map((g) => ({
        key: `fl:${g.key}`,
        date: lastSubmittedAt([...g.rw, ...g.math])!,
        testName: (testById.get(g.parentId)?.test_name as string | undefined) ?? "—",
        href: `/teacher/tests/${g.parentId}/results`,
        kind: "full" as const,
        sections: [
          { section: "Reading & Writing", sat: g.score.rw.score?.sat ?? null, modules: flModuleCells(g.score.rw) },
          { section: "Math", sat: g.score.math.score?.sat ?? null, modules: flModuleCells(g.score.math) },
        ],
        total: g.score.total,
        estimated: g.score.score?.estimated,
      })),
  ];

  // Summary stats (Overview tab).
  const stats = (
    <div className={clsx("grid grid-cols-2 gap-4", latestFl ? "sm:grid-cols-4" : "sm:grid-cols-3")}>
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
      {/* A real one-sitting total only; no estimate from adding up section tests. */}
      {latestFl && (
        <div className="bg-surface border border-divider rounded-2xl p-5">
          <p className="text-soft-mute text-xs">Total · Full-length SAT</p>
          <p className="text-3xl font-bold text-charcoal mt-1">{latestFl.total}</p>
        </div>
      )}
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
  );

  // Tests tab: one table; each finished attempt expands to its module names,
  // module scores and that test's domain breakdown (was "Score Report — By Test").
  const occBySubmission = new Map<string, Occasion>();
  for (const o of occasions) for (const sid of o.submissionIds ?? []) occBySubmission.set(sid, o);
  const breakdowns: Record<string, ReactNode> = {};
  for (const r of testRows) {
    const ids = [r.detailSubmissionId, ...r.modules.map((m) => m.submissionId)].filter((x): x is string => Boolean(x));
    const occs = Array.from(new Set(ids.map((sid) => occBySubmission.get(sid)).filter((o): o is Occasion => Boolean(o))));
    const rows = occs.flatMap((o) => o.rows);
    if (rows.length > 0) breakdowns[r.key] = <ScoreBreakdown rows={rows} title={tt("breakdownTitle")} />;
  }
  const testsPanel = (
    <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-divider flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-charcoal font-semibold">{tt("tests")}</h2>
        {testRows.length > 0 && testsActions(true)}
      </div>
      <TestsTable
        rows={testRows}
        studentId={id}
        studentName={student.display_name ?? student.email}
        emptyActions={testsActions(false)}
        breakdowns={breakdowns}
      />
    </div>
  );

  // Overview tab: recent scores, the score chart, three takeaways, summary stats.
  const overview = (
    <>
      <RecentPracticeTests items={recentItems} />
      {occasions.length > 1 && <ScoreProgressChart occasions={occasions} />}
      <StudentConclusions occasions={occasions} studentId={student.id} displayName={student.display_name} />
      {stats}
    </>
  );

  const checkProfileMeta = student.metadata?.check_profile as
    | { reason: string; at: string }
    | undefined;

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
            time_multiplier: profileTimeMultiplier(student.metadata),
          }}
          classNames={memberships.map((m) => m.name)}
        />
        {occasions.length > 0 && (
          <Link href={`/report?student=${student.id}`} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-divider text-sm font-medium text-charcoal hover:bg-light-bg transition-colors">
            Download PDF report
          </Link>
        )}
        {occasions.length > 0 && (
          <Link href={`/print/students/${student.id}/report`} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-divider text-sm font-medium text-charcoal hover:bg-light-bg transition-colors">
            Download one-page report
          </Link>
        )}
        <StudentActionsMenu
          studentId={student.id}
          studentName={student.display_name ?? student.email}
          email={student.email}
          status={student.account_status}
          classItems={classPickerItems}
          testItems={testPickerItems}
          isSuperAdmin={me?.isSuperAdmin ?? false}
          attemptCount={submissions.length}
        />
      </div>

      {checkProfileMeta && (
        <div className="bg-warm-amber/10 border border-warm-amber/20 rounded-xl px-4 py-3 text-sm">
          <CheckProfileBadge studentId={student.id} reason={checkProfileMeta.reason} />
        </div>
      )}

      <StudentTabs
        panels={[
          { id: "overview", label: tt("overview"), content: overview },
          { id: "tests", label: tt("tests"), content: testsPanel },
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
            content: (
              <StudentProfileCard
                fields={[
                  ["grade", profile?.grade],
                  ["school", profile?.school],
                  ["campus", profile?.campus],
                  [
                    memberships.length > 1 ? "classes" : "classGroup",
                    memberships.length === 0
                      ? null
                      : memberships.map((m, i) => (
                          <span key={m.id}>
                            {i > 0 && ", "}
                            <Link href={`/admin/classes/${m.id}`} className="hover:text-warm-coral transition-colors">
                              {m.name}
                            </Link>
                          </span>
                        )),
                  ],
                  ["targetScore", profile?.target_score?.toString()],
                  ["level", profile?.current_level],
                  ["parent", profile?.parent_name],
                  ["parentContact", profile?.parent_email || profile?.parent_phone],
                ]}
                notes={profile?.notes}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
