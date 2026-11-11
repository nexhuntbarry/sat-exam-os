import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { getQaClassGroupIds, getQaTestIds, onSide } from "@/lib/qa";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import GrantRetakeButton from "./GrantRetakeButton";
import ResultsDownloadPanel from "@/components/print/ResultsDownloadPanel";
import { formatDateTimeSeconds, formatShortDateTime, formatShortDate } from "@/lib/datetime";
import { type AttemptScore } from "@/lib/score-display";
import { fullLengthLinksOrNone } from "@/lib/full-length";
import { attemptGroupKey, flBadge, loadFlAttemptMeta, scoreAttemptGroup } from "@/lib/full-length-score";
import { sectionDetailRowId } from "@/lib/full-length-results";
import { getTestSections } from "@/lib/teacher-access";
import { ScoreCell } from "@/components/ui/ScoreCell";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { X, Eye } from "lucide-react";
import { tabSwitchTotal } from "@/lib/tab-switches";
import { TabSwitchCount, TabSwitchHeader } from "@/components/analytics/TabSwitchCount";
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
  TwoLineCell,
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

  // Full-length SAT parent: its attempts are on its two section children.
  const flLinks = await fullLengthLinksOrNone(db);
  const flKids = flLinks.childrenOf.get(testId) ?? null;
  let query = db
    .from("submissions")
    .select(`
      id, test_id, student_id, status, score, correct_count, total_questions,
      percentage, started_at, submitted_at, time_spent_seconds, attempt_number,
      adaptive_track, module_id, session_id, tab_switches:metadata->tab_switches,
      users!inner(display_name, email),
      modules!module_id(module_name)
    `)
    .in("test_id", flKids ? [flKids.rw, flKids.math].filter((x): x is string => Boolean(x)) : [testId]);

  if (classFilterStudentIds && classFilterStudentIds.size > 0) {
    query = query.in("student_id", Array.from(classFilterStudentIds));
  } else if (classFilterStudentIds && classFilterStudentIds.size === 0) {
    // Class exists but has no members — return empty
    return { test, submissions: [], pendingByStudent: new Set<string>(), classFilterName, classFilterId: classFilter ?? null, flLinks, flKids, flMeta: null };
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

  const flMeta = flKids ? await loadFlAttemptMeta(db, [testId]) : null;
  return { test, submissions: submissions ?? [], pendingByStudent, classFilterName, classFilterId: classFilter ?? null, flLinks, flKids, flMeta };
}

const TRACK_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
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

  const { test, submissions, pendingByStudent, classFilterName, classFilterId, flLinks, flKids, flMeta } = data;

  type RawSubmission = (typeof submissions)[number];
  const section = (await getTestSections(getServiceClient(), [test.id])).get(test.id) ?? null;

  type Attempt = {
    key: string;
    studentId: string;
    studentDisplayName: string;
    studentEmail: string;
    moduleHeadline: string;
    attempt: AttemptScore;
    /** Full-length SAT: badge label ("On break", "Closed — Math not taken", "In progress · Math · Module 1"). */
    statusLabel?: string;
    timeSpentSeconds: number;
    submittedAt: string | null;
    attemptNumber: number;
    /** Times the student left the exam tab, all modules / both sections. */
    tabSwitches: number | null;
    detailSubmissionId: string;
    /** The test of the detail row (a full-length section's own id), default the page's test. */
    detailTestId?: string;
    // When the attempt is still in progress but a module is already
    // graded, point the admin at it so they can inspect what's done.
    partialDetailSubmissionId: string | null;
  };

  // Two-module attempts produce two submission rows sharing one
  // session_id; group siblings so the admin sees one row per attempt,
  // scored with the shared score display. Legacy single-module rows
  // (session_id NULL) stay as their own group.
  const bySession = new Map<string, RawSubmission[]>();
  for (const s of submissions) {
    // A full-length SAT attempt (both sections) is one row.
    const key = attemptGroupKey(s, flLinks);
    bySession.set(key, [...(bySession.get(key) ?? []), s]);
  }

  const attempts: Attempt[] = [];
  for (const [key, list] of bySession) {
    const sorted = [...list].sort((a, b) => {
      const rank = (t: string | null) => (t === "module_1" ? 0 : 1);
      return rank(a.adaptive_track) - rank(b.adaptive_track);
    });
    const head = sorted[0];
    const u = head.users as unknown as { display_name: string; email: string };
    const mod = head.modules as unknown as { module_name: string } | null;
    const trackLabel = head.adaptive_track
      ? TRACK_LABEL[head.adaptive_track] ?? head.adaptive_track
      : null;
    const { fullLength: fl, ...attempt } = scoreAttemptGroup(sorted, flLinks, section, flMeta ?? undefined);
    if (fl && flKids) {
      const rwRows = sorted.filter((r) => r.test_id === flKids.rw);
      const mathRows = sorted.filter((r) => r.test_id === flKids.math);
      const part = (name: string, a: AttemptScore, track: string | null) =>
        `${name} ${a.score?.modules ?? "—"}${track ? ` (${track})` : ""}`;
      const rwDetail = flKids.rw ? sectionDetailRowId(rwRows) : null;
      const mathDetail = flKids.math ? sectionDetailRowId(mathRows) : null;
      const badge = flBadge(fl);
      attempts.push({
        key,
        studentId: head.student_id,
        studentDisplayName: u.display_name,
        studentEmail: u.email,
        moduleHeadline: `${part("R&W", fl.rw, fl.rwTrack)} · ${part("Math", fl.math, fl.mathTrack)}`,
        attempt,
        statusLabel: badge.label ?? (fl.status === "In progress" && fl.current ? `In progress · ${fl.current}` : undefined),
        timeSpentSeconds: sorted.reduce((acc, r) => acc + (r.time_spent_seconds ?? 0), 0),
        submittedAt:
          sorted
            .map((r) => r.submitted_at)
            .filter((d): d is string => !!d)
            .sort()
            .pop() ?? null,
        attemptNumber: head.attempt_number ?? 1,
        tabSwitches: tabSwitchTotal(sorted),
        // The section detail pages (R&W first; each links to the other).
        detailSubmissionId: rwDetail ?? mathDetail ?? sorted[sorted.length - 1].id,
        detailTestId: rwDetail ? flKids.rw! : flKids.math ?? test.id,
        partialDetailSubmissionId: attempt.status === "In progress" ? rwDetail ?? mathDetail : null,
      });
      continue;
    }
    attempts.push({
      key,
      studentId: head.student_id,
      studentDisplayName: u.display_name,
      studentEmail: u.email,
      moduleHeadline: sorted.length > 1
        ? "Module 1 + Module 2"
        : trackLabel
        ? mod?.module_name
          ? `${trackLabel} · ${mod.module_name}`
          : trackLabel
        : mod?.module_name ?? "—",
      attempt,
      timeSpentSeconds: sorted.reduce((acc, r) => acc + (r.time_spent_seconds ?? 0), 0),
      submittedAt:
        sorted
          .map((r) => r.submitted_at)
          .filter((d): d is string => !!d)
          .sort()
          .pop() ?? null,
      attemptNumber: head.attempt_number ?? 1,
      tabSwitches: tabSwitchTotal(sorted),
      // Detail link routes to the Module 2 (last) submission so the
      // result view can stitch both modules via session_id.
      detailSubmissionId: sorted[sorted.length - 1].id,
      partialDetailSubmissionId:
        attempt.status === "In progress"
          ? sorted.find((r) => r.status === "Submitted" || r.status === "Late")?.id ?? null
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

      {attempts.length > 0 && <ResultsDownloadPanel testId={test.id} />}

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
              <Th priority="2xl">Time</Th>
              <Th priority="md"><TabSwitchHeader /></Th>
              <Th priority="lg">Submitted</Th>
              <Th priority="2xl">Attempt</Th>
              <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
            </HeadRow>
          </thead>
          <tbody>
            {attempts.map((a) => {
              const submittedLabel = a.submittedAt ? formatShortDateTime(a.submittedAt) : "—";
              const submittedTitle = a.submittedAt ? formatDateTimeSeconds(a.submittedAt) : undefined;

              // Rule 4: viewing the attempt is the visible action (and the
              // row link); Grant retake is in ⋯.
              const done = a.attempt.status === "Submitted" || a.attempt.status === "Late";
              const detailTest = a.detailTestId ?? test.id;
              const primary =
                done
                  ? { label: "View detail", href: `/teacher/tests/${detailTest}/results/${a.detailSubmissionId}` }
                  : a.partialDetailSubmissionId
                  ? { label: "View partial", href: `/teacher/tests/${detailTest}/results/${a.partialDetailSubmissionId}` }
                  : null;

              return (
                <DataRow
                  key={a.key}
                  href={primary?.href}
                  expandBelow="2xl"
                  colSpan={COL_SPAN}
                  details={
                    <>
                      <DetailItem label="Module" priority="md">{a.moduleHeadline}</DetailItem>
                      <DetailItem label="Time" priority="2xl">{formatDuration(a.timeSpentSeconds)}</DetailItem>
                      <DetailItem label="Left tab" priority="md"><TabSwitchCount count={a.tabSwitches} /></DetailItem>
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
                    {a.moduleHeadline}
                  </Td>
                  <Td>
                    <StatusBadge kind="attempt" status={a.attempt.status} module={a.attempt.module} label={a.statusLabel} />
                  </Td>
                  <Td>
                    <ScoreCell score={a.attempt.score} />
                  </Td>
                  <Td priority="2xl" className="text-mid-gray">
                    {formatDuration(a.timeSpentSeconds)}
                  </Td>
                  <Td priority="md" className="whitespace-nowrap">
                    <TabSwitchCount count={a.tabSwitches} />
                  </Td>
                  <Td priority="lg" className="text-soft-mute" title={submittedTitle}>
                    {submittedLabel}
                  </Td>
                  <Td priority="2xl" className="text-mid-gray">
                    #{a.attemptNumber}
                  </Td>
                  <Td kind="actions" sticky="right">
                    <RowActions>
                    <ExpandToggle label={`More about ${a.studentDisplayName}`} />
                    {primary && <RowButton label={primary.label} icon={<Eye size={13} />} href={primary.href} />}
                    {done && (
                      <GrantRetakeButton
                        testId={test.id}
                        studentId={a.studentId}
                        studentName={a.studentDisplayName ?? a.studentEmail}
                        alreadyPending={pendingByStudent.has(a.studentId)}
                      />
                    )}
                    </RowActions>
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
