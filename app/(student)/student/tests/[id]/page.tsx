import { getServiceClient } from "@/lib/supabase";
import { fullLengthLinksOrNone, resolveParentTestId } from "@/lib/full-length";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Clock, BookOpen, Calendar } from "lucide-react";
import StartTestButton from "./StartTestButton";
import FullLengthLanding from "./FullLengthLanding";
import RefreshAtOpenTime from "./RefreshAtOpenTime";
import { formatDate, formatDateTime } from "@/lib/datetime";
import {
  isModule2Track,
  isTestAssignedToStudent,
  scopeToStudentQuestionSet,
} from "@/lib/student-exam";
import { getAnswerVisibility } from "@/lib/answer-visibility";
import { module2RecoveryBlock } from "@/lib/module2-handoff";

async function getTestInfo(testId: string, studentId: string) {
  const db = getServiceClient();

  // Check access: assigned students always get in. Unassigned students who
  // have an unfinished attempt may still resume — either an In Progress
  // submission OR a graded M1 awaiting M2 (the handoff case). We show the
  // page but mark isAssigned=false so the render suppresses "Start new attempt".
  const isAssigned = await isTestAssignedToStudent(db, testId, studentId);
  if (!isAssigned) {
    // Check for any In Progress submission or graded M1 missing M2.
    const { data: subs } = await db
      .from("submissions")
      .select("status, adaptive_track, attempt_number")
      .eq("test_id", testId)
      .eq("student_id", studentId)
      .in("status", ["In Progress", "Submitted", "Late"])
      .order("attempt_number", { ascending: false });
    if (!subs || subs.length === 0) return null;
    const latestAttempt = (subs[0].attempt_number as number) ?? 1;
    const latestRows = subs.filter((s) => (s.attempt_number as number ?? 1) === latestAttempt);
    const hasInProgress = latestRows.some((s) => s.status === "In Progress");
    const hasGradedM1 = latestRows.some(
      (s) => s.adaptive_track === "module_1" && (s.status === "Submitted" || s.status === "Late"),
    );
    const hasM2 = latestRows.some((s) => s.adaptive_track && s.adaptive_track !== "module_1");
    if (!hasInProgress && !(hasGradedM1 && !hasM2)) return null;
  }

  const { data: test } = await db
    .from("tests")
    .select(`
      id, test_name, status, time_limit_minutes, time_limit_minutes_module_2,
      due_date, open_date,
      allow_retake, show_answers_after_submission, module_id, module_2_id, is_untimed,
      is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id,
      modules!module_id(module_name, section, module_number)
    `)
    .eq("id", testId)
    .single();

  if (!test || test.status === "Draft") return null;

  // For two-module tests (adaptive or non-adaptive module_2_id) we
  // also need to pull Module 2's metadata + question count so the
  // landing card can show the right "Module 1 + Module 2" subtitle and
  // the combined question count.
  const isTwoModule = Boolean(test.is_adaptive) || Boolean(test.module_2_id);
  const m2ModuleIdForMeta = test.is_adaptive
    ? test.module_2_easy_id ?? test.module_2_hard_id
    : test.module_2_id;
  let module2Meta:
    | { module_name: string; section: string; module_number: number | null }
    | null = null;
  if (m2ModuleIdForMeta) {
    const { data: m2 } = await db
      .from("modules")
      .select("module_name, section, module_number")
      .eq("id", m2ModuleIdForMeta)
      .maybeSingle();
    module2Meta = (m2 as { module_name: string; section: string; module_number: number | null } | null) ?? null;
  }

  // Student-visible (Approved) question count — the same set the take
  // page shows and submit grades. Two-module tests sum Module 1 + Module 2
  // so the student sees the full attempt size, not half of it.
  const m1ModuleId = test.is_adaptive ? test.module_1_id : test.module_id;
  const m2ModuleId = test.is_adaptive ? test.module_2_easy_id : test.module_2_id;
  const countQuestions = (moduleId: string) =>
    scopeToStudentQuestionSet(
      db
        .from("questions")
        .select("id", { count: "exact", head: true })
        .eq("module_id", moduleId),
      test,
    );
  const [{ count: m1Count }, { count: m2Count }] = await Promise.all([
    m1ModuleId ? countQuestions(m1ModuleId) : Promise.resolve({ count: 0 }),
    m2ModuleId ? countQuestions(m2ModuleId) : Promise.resolve({ count: 0 }),
  ]);
  const totalQuestionCount = (m1Count ?? 0) + (m2Count ?? 0);

  // Pull every submission for this student on this test so we can
  // build a combined headline for two-module attempts. Sorted by
  // started_at ascending so [0] = Module 1, [1] = Module 2 when both
  // exist. The legacy single-row path picks the only row out of this.
  const { data: subs } = await db
    .from("submissions")
    .select(
      "id, status, score, percentage, correct_count, total_questions, submitted_at, attempt_number, session_id, adaptive_track, started_at",
    )
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .order("attempt_number", { ascending: false })
    .order("started_at", { ascending: true });

  let submission:
    | {
        id: string;
        status: string;
        percentage: number | null;
        submitted_at: string | null;
      }
    | null = null;
  let combinedPct: number | null = null;
  // Module 1 graded but no Module 2 row (the handoff failed or the
  // student crashed before it was created): the attempt is NOT finished.
  let needsModule2 = false;
  let module1SubmittedAt: string | null = null;
  if (subs && subs.length > 0) {
    const latestAttempt = subs[0].attempt_number;
    const sessionRows = subs.filter((s) => s.attempt_number === latestAttempt);
    const isDone = (s: { status: string }) => s.status === "Submitted" || s.status === "Late";
    const allSubmitted = sessionRows.every(isDone);
    needsModule2 =
      isTwoModule &&
      sessionRows.some((s) => s.adaptive_track === "module_1" && isDone(s)) &&
      !sessionRows.some((s) => isModule2Track(s.adaptive_track));
    module1SubmittedAt =
      (sessionRows.find((s) => s.adaptive_track === "module_1")?.submitted_at as string | null) ?? null;
    if (sessionRows.length > 1 && allSubmitted) {
      const correct = sessionRows.reduce((a, s) => a + (s.correct_count ?? 0), 0);
      const total = sessionRows.reduce((a, s) => a + (s.total_questions ?? 0), 0);
      combinedPct = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
    }
    // Headline row: any In Progress module wins (a submitted Module 1
    // must never hide a half-done Module 2 — the student would see "Test
    // Submitted" with no way back in). Otherwise the most recently
    // submitted row, so "View Result" routes to a fully graded submission.
    const inProgress = sessionRows.find((s) => s.status === "In Progress");
    const sorted = [...sessionRows].sort((a, b) => {
      if (a.submitted_at && b.submitted_at)
        return b.submitted_at.localeCompare(a.submitted_at);
      if (a.submitted_at) return -1;
      if (b.submitted_at) return 1;
      return 0;
    });
    const headline = inProgress ?? sorted[0];
    submission = {
      id: headline.id,
      status: headline.status,
      percentage: headline.percentage != null ? Number(headline.percentage) : null,
      submitted_at: headline.submitted_at,
    };
  }

  // A teacher/admin can grant a one-off retake even when the test itself
  // isn't marked allow_retake. Surface a pending (unconsumed) grant so the
  // UI offers the retake button.
  const { data: grant } = await db
    .from("test_retake_grants")
    .select("id")
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .is("consumed_at", null)
    .limit(1)
    .maybeSingle();

  // Same decision the /review page enforces, so the link only shows when
  // the page will actually open for this student.
  const classReview = await getAnswerVisibility(db, testId, studentId, "class_review");

  return {
    test,
    isAssigned,
    canOpenClassReview: classReview.answers,
    questionCount: totalQuestionCount,
    submission,
    module2Meta,
    isTwoModule,
    combinedPct,
    needsModule2,
    // Past the due date a missing Module 2 can only be opened within 24 h
    // of Module 1 (same rule as the server's recovery).
    // Any reason recovery would refuse (past due, test closed / archived):
    // say so instead of offering a Continue button that would 403.
    module2Closed: needsModule2 ? module2RecoveryBlock(test, module1SubmittedAt) : null,
    hasRetakeGrant: Boolean(grant),
  };
}

export default async function StudentTestLandingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  // A full-length SAT section is only ever opened through its parent.
  const linksDb = getServiceClient();
  const parentId = await resolveParentTestId(linksDb, id);
  if (parentId !== id) redirect(`/student/tests/${parentId}`);
  // A full-length SAT parent has its own landing (sections, break, attempt
  // state). Same memoized links read as resolveParentTestId.
  if ((await fullLengthLinksOrNone(linksDb)).childrenOf.has(id)) {
    return <FullLengthLanding db={linksDb} testId={id} studentId={user.userId} />;
  }
  const data = await getTestInfo(id, user.userId);
  if (!data) notFound();

  const { test, isAssigned, canOpenClassReview, questionCount, submission, module2Meta, isTwoModule, combinedPct, needsModule2, module2Closed, hasRetakeGrant } = data;
  const mod = test.modules as unknown as
    | { module_name: string; section: string; module_number: number | null }
    | null;
  const m1Limit = test.time_limit_minutes;
  const m2Limit = test.time_limit_minutes_module_2 ?? m1Limit;
  const timeLimitDisplay = test.is_untimed
    ? "Untimed"
    : isTwoModule && m1Limit
    ? `${m1Limit} + ${m2Limit} min`
    : m1Limit
    ? `${m1Limit} min`
    : "—";

  const isPastDue = test.due_date && new Date(test.due_date) < new Date();
  const isNotOpenYet = Boolean(test.open_date && new Date(test.open_date) > new Date());
  const isInProgress = submission?.status === "In Progress";
  const isSubmitted =
    !needsModule2 && (submission?.status === "Submitted" || submission?.status === "Late");
  // Retake is offered when the test allows it OR a teacher granted a
  // one-off retake to this student.
  // Retake and starting fresh both require the student to be assigned.
  // An unassigned student who has an in-progress session may only resume.
  const canRetake = isAssigned && (test.allow_retake || hasRetakeGrant) && isSubmitted;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/student/tests" className="hover:text-charcoal transition-colors">My Tests</Link>
        <span>/</span>
        <span className="text-charcoal">{test.test_name}</span>
      </div>

      <div className="bg-surface border border-divider rounded-2xl p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-charcoal mb-1">{test.test_name}</h1>
          <p className="text-soft-mute">
            {mod ? (
              <>
                {mod.module_name} · {mod.section}
                {mod.module_number ? ` M${mod.module_number}` : ""}
                {module2Meta && (
                  <>
                    {" "}
                    <span className="text-charcoal/40">+</span>{" "}
                    {module2Meta.module_name} · {module2Meta.section}
                    {module2Meta.module_number ? ` M${module2Meta.module_number}` : ""}
                  </>
                )}
              </>
            ) : (
              "Adaptive · Module 1 + Module 2 (easy/hard)"
            )}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl">
            <Clock size={20} className="text-warm-coral-text mb-2" />
            <div className="text-charcoal font-semibold">{timeLimitDisplay}</div>
            <div className="text-soft-mute text-xs">Time Limit</div>
          </div>
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl">
            <BookOpen size={20} className="text-warm-coral-text mb-2" />
            <div className="text-charcoal font-semibold">{questionCount}</div>
            <div className="text-soft-mute text-xs">Questions</div>
          </div>
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl">
            <Calendar size={20} className="text-warm-coral-text mb-2" />
            <div className="text-charcoal font-semibold text-sm">
              {test.due_date ? formatDate(test.due_date) : "No deadline"}
            </div>
            <div className="text-soft-mute text-xs">Due Date</div>
          </div>
        </div>

        {/* State-based CTA */}
        {isSubmitted && !canRetake ? (
          <div className="space-y-3">
            <div className="p-4 bg-warm-amber/10 border border-warm-amber/20 rounded-xl text-center">
              <div className="text-warm-amber font-semibold mb-1">
                Test Submitted{combinedPct != null ? " · combined" : ""}
              </div>
              <div className="text-charcoal text-2xl font-bold">
                {combinedPct != null
                  ? `${combinedPct.toFixed(1)}%`
                  : submission?.percentage != null
                  ? `${Number(submission.percentage).toFixed(1)}%`
                  : ""}
              </div>
            </div>
            <Link
              href={`/student/tests/${test.id}/result`}
              className="block w-full py-3 text-center rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold transition-colors"
            >
              View Result
            </Link>
          </div>
        ) : needsModule2 && module2Closed ? (
          <div className="p-4 bg-status-error/10 border border-status-error/20 rounded-xl text-center text-status-error">
            {module2Closed === "past_due"
              ? "This attempt is closed — Module 1 was submitted, but Module 2 can't be started after the due date."
              : "This attempt is closed — Module 1 was submitted, but this test is no longer open."}{" "}
            Ask your teacher if you need to finish it.
          </div>
        ) : needsModule2 ? (
          <div className="space-y-3">
            <p className="text-status-warning text-sm text-center">
              Module 1 is submitted. Your test isn&apos;t finished yet — continue to Module 2.
            </p>
            {/* POST /api/student/submissions recreates the missing Module 2
                row for this attempt, then opens the take page. Past the due
                date only within 24 h of Module 1 (module2Closed above). */}
            <StartTestButton testId={test.id} isResume={false} label="Continue to Module 2" />
          </div>
        ) : isPastDue && !isInProgress ? (
          <div className="p-4 bg-status-error/10 border border-status-error/20 rounded-xl text-center text-status-error">
            This test is no longer available — the due date has passed.
          </div>
        ) : isNotOpenYet && !isInProgress ? (
          <div className="p-4 bg-light-bg border border-divider rounded-xl text-center text-mid-gray">
            This test opens on {formatDateTime(test.open_date as string)}.
            <RefreshAtOpenTime openAt={test.open_date as string} serverNow={Date.now()} />
          </div>
        ) : !isAssigned && !isInProgress ? (
          // Unassigned and no in-progress session: should normally be gated
          // earlier by notFound(), but guard defensively here too.
          <div className="p-4 bg-status-error/10 border border-status-error/20 rounded-xl text-center text-status-error">
            This test is not assigned to you.
          </div>
        ) : (
          <div className="space-y-3">
            {isInProgress && (
              <p className="text-status-warning text-sm text-center">
                You have an in-progress submission. Resuming will continue from where you left off.
              </p>
            )}
            {!isAssigned && isInProgress && (
              <p className="text-soft-mute text-xs text-center">
                You can finish this attempt, but you&apos;re no longer assigned to this test.
              </p>
            )}
            {/* When not assigned, only show Resume (never Start new attempt). */}
            {(isAssigned || isInProgress) && (
              <StartTestButton
                testId={test.id}
                submissionId={isInProgress ? submission?.id : undefined}
                isResume={isInProgress}
              />
            )}
          </div>
        )}

        {canOpenClassReview && (
          <Link
            href={`/student/tests/${test.id}/review`}
            className="block w-full py-3 text-center rounded-xl border border-warm-amber/30 bg-warm-amber/10 text-warm-amber font-semibold transition-colors hover:bg-warm-amber/20"
          >
            Open class review (answers unlocked)
          </Link>
        )}
      </div>
    </div>
  );
}
