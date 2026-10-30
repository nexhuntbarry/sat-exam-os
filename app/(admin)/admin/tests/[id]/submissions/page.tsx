import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, onSide } from "@/lib/qa";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { clsx } from "clsx";
import GrantRetakeButton from "./GrantRetakeButton";
import { formatDateTimeSeconds, formatShortDateTime, formatShortDate } from "@/lib/datetime";
import { scaleSectionScore } from "@/lib/scoring";
import { X, Eye } from "lucide-react";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  RowActionsMenu,
  TwoLineCell,
  type RowAction,
} from "@/components/ui/data-table";

async function getSubmissions(testId: string, viewerIsQa: boolean, classFilter?: string) {
  const db = getServiceClient();

  const { data: test } = await db
    .from("tests")
    .select("id, test_name, status")
    .eq("id", testId)
    .single();

  if (!test) return null;

  // Resolve class filter: look up name + member student ids.
  // Silently drop the filter if the class group is on the wrong QA side.
  let classFilterName: string | null = null;
  let classFilterStudentIds: Set<string> | null = null;
  if (classFilter) {
    const qaGroups = await getQaClassGroupIds();
    if (onSide(classFilter, qaGroups, viewerIsQa)) {
      const { data: cg } = await db
        .from("class_groups")
        .select("id, name")
        .eq("id", classFilter)
        .maybeSingle();
      if (cg) {
        classFilterName = (cg as { name: string }).name;
        const { data: memberRows } = await db
          .from("class_group_members")
          .select("student_id")
          .eq("class_group_id", classFilter);
        classFilterStudentIds = new Set((memberRows ?? []).map((m) => m.student_id as string));
      }
    }
    // If not on the same side, classFilter* stays null — filter is silently ignored.
  }

  let query = db
    .from("submissions")
    .select(`
      id, student_id, status, score, correct_count, total_questions,
      percentage, started_at, submitted_at, time_spent_seconds, attempt_number,
      adaptive_track, module_id, session_id,
      users!inner(display_name, email),
      modules!module_id(module_name)
    `)
    .eq("test_id", testId);

  if (classFilterStudentIds && classFilterStudentIds.size > 0) {
    query = query.in("student_id", Array.from(classFilterStudentIds));
  } else if (classFilterStudentIds && classFilterStudentIds.size === 0) {
    // Class exists but has no members — return empty
    return { test, submissions: [], pendingByStudent: new Set<string>(), classFilterName, classFilterId: classFilter ?? null };
  }

  const { data: submissions } = await query.order("submitted_at", { ascending: false });

  // Pending retake grants — keyed by student so the row can show
  // either a "Grant retake" button or an existing "Retake granted" pill.
  const { data: grants } = await db
    .from("test_retake_grants")
    .select("student_id")
    .eq("test_id", testId)
    .is("consumed_at", null);
  const pendingByStudent = new Set((grants ?? []).map((g) => g.student_id as string));

  return { test, submissions: submissions ?? [], pendingByStudent, classFilterName, classFilterId: classFilter ?? null };
}

const TRACK_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
};


const statusStyles: Record<string, string> = {
  "In Progress": "bg-warm-coral/15 text-warm-coral-text",
  Submitted: "bg-warm-amber/15 text-warm-amber",
  Late: "bg-status-warning/15 text-status-warning",
  Expired: "bg-status-error/15 text-status-error",
};

function formatDuration(seconds: number | null) {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export default async function TestSubmissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ class?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") redirect("/sign-in");

  const { id } = await params;
  const { class: classParam } = await searchParams;
  if (!onSide(id, await getQaTestIds(), user.isQa)) notFound();
  const data = await getSubmissions(id, user.isQa, classParam);
  if (!data) notFound();

  const { test, submissions, pendingByStudent, classFilterName, classFilterId } = data;

  type RawSubmission = (typeof submissions)[number];

  type ModuleView = {
    submissionId: string;
    label: string;
    correctCount: number;
    totalQuestions: number;
    percentage: number | null;
    scaledScore: number | null;
    status: string;
  };

  type Attempt = {
    key: string;
    studentId: string;
    studentDisplayName: string;
    studentEmail: string;
    moduleHeadline: string;
    status: string;
    correctCount: number;
    totalQuestions: number;
    percentage: number | null;
    scaledScore: number | null;
    timeSpentSeconds: number;
    submittedAt: string | null;
    attemptNumber: number;
    detailSubmissionId: string;
    isMultiModule: boolean;
    modules: ModuleView[];
    // When this is a multi-module attempt with at least one module
    // submitted but another still In Progress, point the admin at
    // the submitted module so they can still inspect what's done.
    partialDetailSubmissionId: string | null;
  };

  // Two-module attempts produce two submission rows sharing one
  // session_id; group siblings so the admin sees one row per attempt
  // with a combined headline plus per-module split. Legacy
  // single-module rows (session_id NULL) stay as their own group.
  const bySession = new Map<string, RawSubmission[]>();
  const singletons: RawSubmission[] = [];
  for (const s of submissions) {
    if (s.session_id) {
      const list = bySession.get(s.session_id) ?? [];
      list.push(s);
      bySession.set(s.session_id, list);
    } else {
      singletons.push(s);
    }
  }

  const attempts: Attempt[] = [];
  for (const s of singletons) {
    const u = s.users as unknown as { display_name: string; email: string };
    const mod = s.modules as unknown as { module_name: string } | null;
    const trackLabel = s.adaptive_track
      ? TRACK_LABEL[s.adaptive_track] ?? s.adaptive_track
      : null;
    const p = s.percentage != null ? Number(s.percentage) : null;
    attempts.push({
      key: s.id,
      studentId: s.student_id,
      studentDisplayName: u.display_name,
      studentEmail: u.email,
      moduleHeadline: trackLabel
        ? mod?.module_name
          ? `${trackLabel} · ${mod.module_name}`
          : trackLabel
        : mod?.module_name ?? "—",
      status: s.status,
      correctCount: s.correct_count ?? 0,
      totalQuestions: s.total_questions ?? 0,
      percentage: p,
      scaledScore: p != null ? scaleSectionScore(p) : null,
      timeSpentSeconds: s.time_spent_seconds ?? 0,
      submittedAt: s.submitted_at,
      attemptNumber: s.attempt_number ?? 1,
      detailSubmissionId: s.id,
      isMultiModule: false,
      modules: [],
      partialDetailSubmissionId: null,
    });
  }
  for (const [sessionId, list] of bySession) {
    if (list.length === 1) {
      const s = list[0];
      const u = s.users as unknown as { display_name: string; email: string };
      const mod = s.modules as unknown as { module_name: string } | null;
      const trackLabel = s.adaptive_track
        ? TRACK_LABEL[s.adaptive_track] ?? s.adaptive_track
        : null;
      const p = s.percentage != null ? Number(s.percentage) : null;
      attempts.push({
        key: s.id,
        studentId: s.student_id,
        studentDisplayName: u.display_name,
        studentEmail: u.email,
        moduleHeadline: trackLabel
          ? mod?.module_name
            ? `${trackLabel} · ${mod.module_name}`
            : trackLabel
          : mod?.module_name ?? "—",
        status: s.status,
        correctCount: s.correct_count ?? 0,
        totalQuestions: s.total_questions ?? 0,
        percentage: p,
        scaledScore: p != null ? scaleSectionScore(p) : null,
        timeSpentSeconds: s.time_spent_seconds ?? 0,
        submittedAt: s.submitted_at,
        attemptNumber: s.attempt_number ?? 1,
        detailSubmissionId: s.id,
        isMultiModule: false,
        modules: [],
        partialDetailSubmissionId: null,
      });
      continue;
    }
    const sorted = [...list].sort((a, b) => {
      const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
      return rank(a.adaptive_track) - rank(b.adaptive_track);
    });
    const head = sorted[0];
    const u = head.users as unknown as { display_name: string; email: string };
    const correct = sorted.reduce((acc, r) => acc + (r.correct_count ?? 0), 0);
    const total = sorted.reduce((acc, r) => acc + (r.total_questions ?? 0), 0);
    const time = sorted.reduce((acc, r) => acc + (r.time_spent_seconds ?? 0), 0);
    const pct = total > 0 ? Math.round((correct / total) * 1000) / 10 : null;
    const statuses = sorted.map((r) => r.status);
    const status = statuses.includes("In Progress")
      ? "In Progress"
      : statuses.includes("Late")
      ? "Late"
      : statuses[statuses.length - 1] ?? "Submitted";
    const lastSubmittedAt =
      sorted
        .map((r) => r.submitted_at)
        .filter((d): d is string => !!d)
        .sort()
        .pop() ?? null;
    attempts.push({
      key: sessionId,
      studentId: head.student_id,
      studentDisplayName: u.display_name,
      studentEmail: u.email,
      moduleHeadline: "Module 1 + Module 2",
      status,
      correctCount: correct,
      totalQuestions: total,
      percentage: pct,
      scaledScore: pct != null ? scaleSectionScore(pct) : null,
      timeSpentSeconds: time,
      submittedAt: lastSubmittedAt,
      attemptNumber: head.attempt_number ?? 1,
      // Detail link routes to the Module 2 (last) submission so the
      // result view can stitch both modules via session_id.
      detailSubmissionId: sorted[sorted.length - 1].id,
      isMultiModule: true,
      modules: sorted.map((r) => {
        const p = r.percentage != null ? Number(r.percentage) : null;
        return {
          submissionId: r.id,
          label: TRACK_LABEL[r.adaptive_track ?? ""] ?? "Module",
          correctCount: r.correct_count ?? 0,
          totalQuestions: r.total_questions ?? 0,
          percentage: p,
          scaledScore: p != null ? scaleSectionScore(p) : null,
          status: r.status,
        };
      }),
      // Surface the most-recent submitted module as a partial-detail
      // target when the attempt is mid-flight.
      partialDetailSubmissionId:
        status === "In Progress"
          ? sorted.find(
              (r) => r.status === "Submitted" || r.status === "Late",
            )?.id ?? null
          : null,
    });
  }

  attempts.sort((a, b) => {
    if (a.submittedAt && b.submittedAt) return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
  });

  const COL_SPAN = 9;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/admin/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <Link href={`/admin/tests/${test.id}`} className="hover:text-charcoal transition-colors">{test.test_name}</Link>
        <span>/</span>
        <span className="text-charcoal">Submissions</span>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold text-charcoal">Submissions — {test.test_name}</h1>
        {classFilterName && classFilterId && (
          <Link
            href={`/admin/tests/${test.id}/submissions`}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-warm-coral/15 text-warm-coral-text text-sm font-medium hover:bg-warm-coral/25 transition-colors"
            title="Remove class filter"
          >
            Filtered: {classFilterName}
            <X size={13} />
            Show all
          </Link>
        )}
      </div>

      {attempts.length === 0 ? (
        <div className="py-16 text-center text-soft-mute text-sm border-y border-divider">
          No submissions yet.
        </div>
      ) : (
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">Student</Th>
              <Th kind="long" priority="md">Module</Th>
              <Th>Status</Th>
              <Th>Score</Th>
              <Th kind="long" priority="md">Correct</Th>
              <Th priority="2xl">Time</Th>
              <Th priority="lg">Submitted</Th>
              <Th priority="2xl">Attempt</Th>
              <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {attempts.map((a) => {
              const scoreMain = a.percentage != null ? `${a.percentage.toFixed(1)}%` : "—";
              const scoreDetail = a.scaledScore != null ? `${a.scaledScore}/800` : undefined;
              const correctMain = a.totalQuestions > 0 ? `${a.correctCount}/${a.totalQuestions}` : "—";
              const submittedLabel = a.submittedAt ? formatShortDateTime(a.submittedAt) : "—";
              const submittedTitle = a.submittedAt ? formatDateTimeSeconds(a.submittedAt) : undefined;

              const moduleBreakdown = a.isMultiModule && a.modules.length > 0
                ? a.modules.map((m) => `${m.label}: ${m.percentage != null ? `${m.percentage.toFixed(1)}%` : "—"}${m.scaledScore != null ? ` · ${m.scaledScore}/800` : ""}`).join(" | ")
                : undefined;
              const correctBreakdown = a.isMultiModule && a.modules.length > 0
                ? a.modules.map((m) => `${m.label}: ${m.correctCount}/${m.totalQuestions}`).join(" | ")
                : undefined;

              const rowActions: (RowAction | false)[] = [
                (a.status === "Submitted" || a.status === "Late")
                  ? { label: "View detail", icon: <Eye size={14} />, href: `/teacher/tests/${test.id}/results/${a.detailSubmissionId}` }
                  : false,
                (a.status === "In Progress" && !!a.partialDetailSubmissionId)
                  ? { label: "View partial", icon: <Eye size={14} />, href: `/teacher/tests/${test.id}/results/${a.partialDetailSubmissionId!}` }
                  : false,
              ];

              return (
                <DataRow
                  key={a.key}
                  expandBelow="2xl"
                  colSpan={COL_SPAN}
                  details={
                    <>
                      <DetailItem label="Module" priority="md">{a.moduleHeadline}</DetailItem>
                      <DetailItem label="Correct" priority="md">{correctMain}{correctBreakdown ? ` (${correctBreakdown})` : ""}</DetailItem>
                      <DetailItem label="Time" priority="2xl">{formatDuration(a.timeSpentSeconds)}</DetailItem>
                      <DetailItem label="Submitted" priority="lg">{submittedLabel}</DetailItem>
                      <DetailItem label="Attempt" priority="2xl">#{a.attemptNumber}</DetailItem>
                    </>
                  }
                >
                  <Td kind="main" sticky="left">
                    <TwoLineCell
                      main={a.studentDisplayName}
                      detail={a.studentEmail}
                      mainClassName="font-medium text-charcoal"
                    />
                  </Td>
                  <Td kind="long" priority="md" className="text-mid-gray">
                    <TwoLineCell
                      main={a.moduleHeadline}
                      detail={moduleBreakdown}
                      mainClassName="font-medium text-charcoal"
                    />
                  </Td>
                  <Td>
                    <span className={clsx("px-2 py-0.5 rounded-full text-xs font-medium", statusStyles[a.status] ?? "bg-light-bg text-mid-gray")}>
                      {a.status}
                    </span>
                  </Td>
                  <Td>
                    <TwoLineCell
                      main={scoreMain}
                      detail={scoreDetail}
                      mainClassName="text-mid-gray"
                    />
                  </Td>
                  <Td kind="long" priority="md" className="text-mid-gray">
                    <TwoLineCell
                      main={correctMain}
                      detail={correctBreakdown}
                      mainClassName="text-mid-gray"
                    />
                  </Td>
                  <Td priority="2xl" className="text-mid-gray">
                    {formatDuration(a.timeSpentSeconds)}
                  </Td>
                  <Td priority="lg" className="text-soft-mute" title={submittedTitle}>
                    {submittedLabel}
                  </Td>
                  <Td priority="2xl" className="text-mid-gray">
                    #{a.attemptNumber}
                  </Td>
                  <Td kind="actions" sticky="right">
                    <ExpandToggle label={`More about ${a.studentDisplayName}`} />
                    <RowActionsMenu label={`Actions for ${a.studentDisplayName}`} items={rowActions} />
                    {(a.status === "Submitted" || a.status === "Late") && (
                      <GrantRetakeButton
                        testId={test.id}
                        studentId={a.studentId}
                        studentName={a.studentDisplayName ?? a.studentEmail}
                        alreadyPending={pendingByStudent.has(a.studentId)}
                      />
                    )}
                  </Td>
                </DataRow>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
