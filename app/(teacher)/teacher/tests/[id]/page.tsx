import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { canManageTestSettings, getTeacherTestAccess, getTestSections } from "@/lib/teacher-access";
import { scopeUsers } from "@/lib/qa";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { formatDate, formatDateTime, formatShortDate } from "@/lib/datetime";
import { averageSat, type AttemptScore } from "@/lib/score-display";
import { expandFullLength, fullLengthLinksOrNone, type FullLengthLinks } from "@/lib/full-length";
import {
  attemptGroupKey,
  FL_ALL_SECTIONS,
  flBadge,
  flSectionScope,
  loadFlAttemptMeta,
  scoreAttemptGroup,
  type FlAttemptMeta,
  type FlSectionScope,
} from "@/lib/full-length-score";
import { ScoreCell } from "@/components/ui/ScoreCell";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { tabSwitchTotal } from "@/lib/tab-switches";
import { TabSwitchHeader } from "@/components/analytics/TabSwitchCount";
import { loadLiveSnapshot } from "@/lib/live-progress";
import { emptyLiveSnapshot, submittedColumnText, type LiveSnapshot } from "@/lib/live-progress-shared";
import {
  LiveProgressCell,
  LiveProgressProvider,
  LiveStatusBar,
  LiveTabSwitchCount,
} from "@/components/analytics/LiveProgressCell";
import ReviewModeToggle from "@/components/tests/ReviewModeToggle";
import AnswerVisibilityToggle from "@/components/tests/AnswerVisibilityToggle";
import {
  DataTable,
  HeadRow,
  Th,
  Td,
  DataRow,
  DetailItem,
  EmptyRow,
  ExpandToggle,
  TwoLineCell,
} from "@/components/ui/data-table";

async function getTeacherTest(
  testId: string,
  user: { userId: string; role: string | null | undefined; isQa: boolean },
) {
  const db = getServiceClient();

  // Two-track access: direct (on teacher_ids) or class-group teacher.
  const access = await getTeacherTestAccess(db, user, testId);
  if (access.mode === null) return null;

  const { data: assignment } = await db
    .from("test_assignments")
    .select("student_ids")
    .eq("test_id", testId)
    .single();

  const { data: test } = await db
    .from("tests")
    .select(`
      id, test_name, status, time_limit_minutes, due_date, open_date,
      show_answers_after_submission, show_explanations_after_submission, allow_retake, review_unlocked,
      modules!module_id(module_name, section, module_number)
    `)
    .eq("id", testId)
    .single();

  if (!test) return null;

  const studentIds: string[] = assignment?.student_ids ?? [];

  // Full-length SAT parent: its attempts are on its two section children.
  const flLinks = await fullLengthLinksOrNone(db);
  const isFullLength = flLinks.childrenOf.has(testId);
  let subQuery = scopeUsers(db
    .from("submissions")
    .select(`
      id, test_id, student_id, status, score, correct_count, total_questions,
      percentage, started_at, submitted_at, time_spent_seconds, session_id, adaptive_track, attempt_number,
      tab_switches:metadata->tab_switches,
      users!inner(display_name, email)
    `)
    .in("test_id", isFullLength ? await expandFullLength(db, [testId]) : [testId]), user.isQa, "users.email")
    .order("submitted_at", { ascending: false });
  // A class-group teacher only sees their own class's attempts.
  if (access.mode === "class" && access.studentAllowlist) {
    subQuery = subQuery.in("student_id", Array.from(access.studentAllowlist));
  }
  const { data: submissions } = await subQuery;
  // A single-subject teacher sees the total plus their own section only.
  const flScope = isFullLength ? await flSectionScope(db, user, flLinks.childrenOf.get(testId)!) : FL_ALL_SECTIONS;

  return {
    test,
    isFullLength,
    flLinks,
    flMeta: isFullLength ? await loadFlAttemptMeta(db, [testId]) : new Map<string, FlAttemptMeta>(),
    flScope,
    // Live progress of unfinished attempts + not-started roster (same scope).
    // A failure renders the page without it; the client polls until it loads.
    liveSnapshot: (await loadLiveSnapshot(db, {
      testId,
      viewerIsQa: user.isQa,
      studentIds: access.mode === "class" ? access.studentAllowlist : null,
      flScope,
    }).catch((e) => {
      console.error("[teacher/tests] live snapshot", e);
      return { ...emptyLiveSnapshot(), degraded: true };
    })) as LiveSnapshot,
    section: (await getTestSections(db, [testId])).get(testId) ?? null,
    studentIds,
    submissions: submissions ?? [],
    canManageSettings: await canManageTestSettings(db, user, testId),
  };
}

type RawSubmission = {
  id: string;
  test_id: string;
  attempt_number: number | null;
  student_id: string;
  status: string;
  score: number | null;
  correct_count: number | null;
  total_questions: number | null;
  percentage: number | string | null;
  started_at: string | null;
  submitted_at: string | null;
  time_spent_seconds: number | null;
  session_id: string | null;
  adaptive_track: string | null;
  tab_switches: unknown;
  users: { display_name: string; email: string };
};

type SubmissionAttempt = {
  key: string;
  studentName: string;
  email: string;
  attempt: AttemptScore;
  statusLabel?: string;
  timeSpentSeconds: number;
  submittedAt: string | null;
  startedAt: string | null;
  tabSwitches: number | null;
};

const attemptDone = (a: SubmissionAttempt) => a.attempt.status === "Submitted" || a.attempt.status === "Late";

// Two-module attempts produce two submission rows sharing one
// session_id; collapse them into one attempt scored with the shared
// score display. Legacy single-module rows (session_id NULL) stay as
// individual attempts.
// A full-length SAT attempt (both sections) is one attempt with the total.
function buildSubmissionAttempts(
  rows: RawSubmission[],
  section: string | null,
  links: FullLengthLinks,
  flMeta: Map<string, FlAttemptMeta>,
  flScope: FlSectionScope,
): SubmissionAttempt[] {
  const bySession = new Map<string, RawSubmission[]>();
  for (const r of rows) {
    const key = attemptGroupKey(r, links);
    bySession.set(key, [...(bySession.get(key) ?? []), r]);
  }

  const attempts: SubmissionAttempt[] = [];
  for (const [key, list] of bySession) {
    attempts.push({
      key,
      studentName: list[0].users.display_name,
      email: list[0].users.email,
      ...(() => {
        const { fullLength, ...attempt } = scoreAttemptGroup(list, links, section, flMeta, () => flScope);
        // Full-length badge label ("On break", "Closed — Math not taken").
        return { attempt, statusLabel: fullLength ? flBadge(fullLength).label : undefined };
      })(),
      timeSpentSeconds: list.reduce((s, r) => s + (r.time_spent_seconds ?? 0), 0),
      submittedAt:
        list
          .map((r) => r.submitted_at)
          .filter((d): d is string => !!d)
          .sort()
          .pop() ?? null,
      startedAt: list.map((r) => r.started_at).filter((d): d is string => !!d).sort()[0] ?? null,
      tabSwitches: tabSwitchTotal(list),
    });
  }

  // Students taking the test right now first, then newest submission first.
  attempts.sort((a, b) => {
    if (attemptDone(a) !== attemptDone(b)) return attemptDone(a) ? 1 : -1;
    if (!attemptDone(a)) return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
    if (a.submittedAt && b.submittedAt)
      return b.submittedAt.localeCompare(a.submittedAt);
    if (a.submittedAt) return -1;
    if (b.submittedAt) return 1;
    return 0;
  });
  return attempts;
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "—";
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default async function TeacherTestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const data = await getTeacherTest(id, user);
  if (!data) notFound();

  const { test, section, submissions, canManageSettings, isFullLength, flLinks, flMeta, flScope, liveSnapshot } = data;
  const notStarted = liveSnapshot.notStarted;
  const mod = test.modules as unknown as
    | { module_name: string; section: string; module_number: number | null }
    | null;
  // Group two-module session siblings into one attempt before computing
  // counts and averages — otherwise each multi-module attempt would
  // double-count in submission totals. Averages use finished attempts only.
  const attempts = buildSubmissionAttempts(
    submissions as unknown as RawSubmission[],
    section,
    flLinks,
    flMeta,
    flScope,
  );
  const submitted = attempts.filter((a) => a.attempt.score?.sat != null);
  const avgSat = averageSat(submitted.map((a) => a.attempt.score?.sat));
  const pcts = submitted.map((a) => a.attempt.score?.pct).filter((p): p is number => p != null);
  const avgPct = pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/teacher/tests" className="hover:text-charcoal transition-colors">Tests</Link>
        <span>/</span>
        <span className="text-charcoal">{test.test_name}</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-charcoal">{test.test_name}</h1>
        <p className="text-soft-mute text-sm mt-1">
          {isFullLength
            ? "Full-length SAT · Reading and Writing + Math · Total 400–1600"
            : mod
            ? <>{mod.module_name} · {mod.section}{mod.module_number ? ` M${mod.module_number}` : ""}</>
            : "Adaptive · Module 1 + Module 2 (easy/hard)"}
        </p>
      </div>

      {canManageSettings ? (
        <>
          <ReviewModeToggle
            testId={test.id}
            initialUnlocked={Boolean((test as { review_unlocked?: boolean }).review_unlocked)}
          />

          <AnswerVisibilityToggle
            testId={test.id}
            initialShowAnswers={Boolean((test as { show_answers_after_submission?: boolean }).show_answers_after_submission)}
            initialShowExplanations={
              (test as { show_explanations_after_submission?: boolean }).show_explanations_after_submission ?? true
            }
          />
        </>
      ) : (
        <div className="rounded-2xl border border-divider bg-surface px-4 py-3 text-xs text-soft-mute leading-relaxed">
          Class review is <span className="font-medium text-mid-gray">{(test as { review_unlocked?: boolean }).review_unlocked ? "unlocked" : "locked"}</span>
          {" · "}answers after submission are{" "}
          <span className="font-medium text-mid-gray">{(test as { show_answers_after_submission?: boolean }).show_answers_after_submission ? "shown" : "hidden"}</span>.
          {" "}These settings apply to every class taking this test, so only the test&rsquo;s owner or an admin can change them.
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Submitted</div>
          <div className="text-2xl font-bold text-charcoal">{submitted.length} / {attempts.length}</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">{isFullLength ? "Avg Total" : "Avg SAT"}</div>
          <div className="text-2xl font-bold text-warm-amber">{avgSat ?? "—"}</div>
          {avgPct != null && <div className="text-soft-mute text-xs">{avgPct.toFixed(1)}% correct</div>}
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4">
          <div className="text-soft-mute text-xs mb-1">Due Date</div>
          <div className="text-charcoal font-semibold text-sm">
            {test.due_date ? formatDateTime(test.due_date) : "—"}
          </div>
        </div>
      </div>

      {/* Action links */}
      <div className="flex flex-wrap gap-3">
        <Link
          href={`/teacher/tests/${id}/review`}
          className="px-4 py-2 rounded-xl bg-warm-coral text-white text-sm font-semibold hover:bg-warm-coral-dark transition-colors"
        >
          Class Review (projector)
        </Link>
        <Link
          href={`/teacher/tests/${id}/results`}
          className="px-4 py-2 rounded-xl bg-warm-coral/10 border border-warm-coral/20 text-warm-coral-text text-sm font-medium hover:bg-warm-coral/20 transition-colors"
        >
          Full Results Dashboard
        </Link>
        <Link
          href={`/teacher/tests/${id}/analytics`}
          className="px-4 py-2 rounded-xl bg-light-bg border border-divider text-mid-gray text-sm font-medium hover:text-charcoal hover:bg-light-bg transition-colors"
        >
          Question Analytics
        </Link>
      </div>

      {/* Submissions list */}
      <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
        <LiveProgressProvider endpoint={`/api/teacher/tests/${test.id}/live-progress`} initial={liveSnapshot}>
        <div className="px-5 py-4 border-b border-divider space-y-1">
          <h2 className="text-charcoal font-semibold">Student Submissions</h2>
          <LiveStatusBar />
        </div>
        {attempts.length === 0 && notStarted.length === 0 ? (
          <div className="py-12 text-center text-soft-mute text-sm">No submissions yet.</div>
        ) : (
          <DataTable className="border-t-0">
            <thead>
              <HeadRow>
                <Th kind="main" sticky="left">Student</Th>
                <Th>Status</Th>
                <Th>Score</Th>
                <Th priority="md">Time</Th>
                <Th priority="md"><TabSwitchHeader /></Th>
                <Th priority="lg">Submitted</Th>
              </HeadRow>
            </thead>
            <tbody>
              {attempts.map((a) => {
                const done = attemptDone(a);
                // Unfinished: when it started (a graded Module 1's time isn't a submission).
                const submittedLabel = submittedColumnText({ finished: done, submittedAt: a.submittedAt, startedAt: a.startedAt });
                const submittedTitle = done
                  ? a.submittedAt ? formatDateTime(a.submittedAt) : undefined
                  : a.startedAt ? `Started ${formatDateTime(a.startedAt)}` : undefined;

                return (
                  <DataRow
                    key={a.key}
                    expandBelow="lg"
                    colSpan={6}
                    details={
                      <>
                        <DetailItem label="Time" priority="md">{formatDuration(a.timeSpentSeconds)}</DetailItem>
                        <DetailItem label="Left tab" priority="md"><LiveTabSwitchCount attemptKey={a.key} count={a.tabSwitches} /></DetailItem>
                        <DetailItem label={done ? "Submitted" : "Started"} priority="lg">{submittedLabel}</DetailItem>
                      </>
                    }
                  >
                    <Td kind="main" sticky="left">
                      <TwoLineCell
                        main={a.studentName}
                        detail={a.email}
                        mainClassName="font-medium text-charcoal"
                      />
                    </Td>
                    <Td>
                      <StatusBadge kind="attempt" status={a.attempt.status} module={a.attempt.module} label={a.statusLabel} />
                      {!done && <LiveProgressCell attemptKey={a.key} />}
                    </Td>
                    <Td>
                      <ScoreCell score={a.attempt.score} />
                    </Td>
                    <Td priority="md" className="text-mid-gray">
                      {formatDuration(a.timeSpentSeconds)}
                    </Td>
                    <Td priority="md" className="whitespace-nowrap">
                      <LiveTabSwitchCount attemptKey={a.key} count={a.tabSwitches} />
                    </Td>
                    <Td priority="lg" className="text-soft-mute" title={submittedTitle}>
                      {submittedLabel}
                    </Td>
                  </DataRow>
                );
              })}
              {/* Assigned, no attempt yet. */}
              {notStarted.map((s) => (
                <DataRow key={`not-started:${s.studentId}`} expandBelow="lg" colSpan={6}>
                  <Td kind="main" sticky="left">
                    <TwoLineCell main={s.name} detail={s.email} mainClassName="font-medium text-charcoal" />
                  </Td>
                  <Td>
                    <StatusBadge kind="attempt" status="Not started" />
                  </Td>
                  <Td className="text-soft-mute">—</Td>
                  <Td priority="md" className="text-soft-mute">—</Td>
                  <Td priority="md" className="text-soft-mute">—</Td>
                  <Td priority="lg" className="text-soft-mute">—</Td>
                </DataRow>
              ))}
            </tbody>
          </DataTable>
        )}
        </LiveProgressProvider>
      </div>
    </div>
  );
}
