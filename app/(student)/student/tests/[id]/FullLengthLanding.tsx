import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, BookOpen, Calendar, Coffee } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { isTestAssignedToStudent, moduleTimeLimitSeconds, scopeToStudentQuestionSet } from "@/lib/student-exam";
import { getAnswerVisibility } from "@/lib/answer-visibility";
import {
  childModule1Id,
  flAttemptFinished,
  flAttemptRows,
  flStateLabel,
  formatDuration,
  latestFlAttempt,
  loadFlContext,
  stateOf,
  type FlChildTest,
} from "@/lib/full-length-attempt";
import StartFullLengthButton from "./StartFullLengthButton";
import RefreshAtOpenTime from "./RefreshAtOpenTime";

// Landing page of a full-length SAT (plan Phase 2): the two sections with
// their effective times (extended time included), the break, where the
// student's attempt is, and Start / Resume / Retake. Retake follows the
// parent's allow_retake and the grants on the parent.

async function sectionInfo(db: SupabaseClient, child: FlChildTest, multiplier: number) {
  const meta = { time_multiplier: multiplier };
  const m2Id = child.is_adaptive ? child.module_2_easy_id ?? child.module_2_hard_id : child.module_2_id;
  const count = async (moduleId: string | null) => {
    if (!moduleId) return 0;
    const { count: n } = await scopeToStudentQuestionSet(
      db.from("questions").select("id", { count: "exact", head: true }),
      child,
      moduleId,
    );
    return n ?? 0;
  };
  const [m1Count, m2Count] = await Promise.all([count(childModule1Id(child)), count(m2Id)]);
  return {
    m1Seconds: moduleTimeLimitSeconds(child, "module_1", meta),
    m2Seconds: moduleTimeLimitSeconds(child, "module_2", meta),
    m1Count,
    m2Count,
  };
}

export default async function FullLengthLanding({
  db,
  testId,
  studentId,
}: {
  db: SupabaseClient;
  testId: string;
  studentId: string;
}) {
  const ctx = await loadFlContext(db, testId);
  if (!ctx || ctx.parent.status === "Draft") notFound();
  const { parent } = ctx;

  const [isAssigned, attempt] = await Promise.all([
    isTestAssignedToStudent(db, testId, studentId),
    latestFlAttempt(db, testId, studentId),
  ]);
  const now = Date.now();
  const st = attempt ? stateOf(ctx, attempt, await flAttemptRows(db, ctx, studentId, attempt.attempt_number), now) : null;
  const open = Boolean(st && !flAttemptFinished(st.state));
  // Same rule as section tests: unassigned students only see a test they
  // still have an attempt to finish.
  if (!isAssigned && !open) notFound();

  // Extended time: a running attempt keeps its snapshot; a new one gets
  // the student's current accommodation.
  let multiplier = 1;
  if (open && attempt) multiplier = Number(attempt.time_multiplier ?? 1) || 1;
  else {
    const { data: acc } = await db
      .from("test_time_accommodations")
      .select("time_multiplier")
      .eq("test_id", testId)
      .eq("student_id", studentId)
      .maybeSingle();
    if (acc?.time_multiplier != null) multiplier = Number(acc.time_multiplier) || 1;
  }

  const [rw, math, { data: grant }, classReview] = await Promise.all([
    sectionInfo(db, ctx.rw, multiplier),
    sectionInfo(db, ctx.math, multiplier),
    db
      .from("test_retake_grants")
      .select("id")
      .eq("test_id", testId)
      .eq("student_id", studentId)
      .is("consumed_at", null)
      .limit(1)
      .maybeSingle(),
    getAnswerVisibility(db, testId, studentId, "class_review"),
  ]);

  const breakMinutes = open && attempt ? attempt.break_minutes ?? 10 : parent.break_minutes ?? 10;
  const allowPause = open && attempt ? Boolean(attempt.allow_section_pause) : Boolean(parent.allow_section_pause);
  const fmt = (s: number | null) => (s == null ? "—" : formatDuration(s));
  const totalSeconds = [rw.m1Seconds, rw.m2Seconds, math.m1Seconds, math.m2Seconds].reduce<number>((a, s) => a + (s ?? 0), 0);

  const isPastDue = Boolean(parent.due_date && Date.parse(parent.due_date) < now);
  const isNotOpenYet = Boolean(parent.open_date && Date.parse(parent.open_date) > now);
  const finished = Boolean(st && flAttemptFinished(st.state));
  const canStartNew = isAssigned && parent.status === "Published" && !isPastDue && !isNotOpenYet;
  const canRetake = finished && canStartNew && (Boolean(parent.allow_retake) || Boolean(grant));
  const mathBlocked = st?.state === "break" && st.mathStartBlock != null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/student/tests" className="hover:text-charcoal transition-colors">My Tests</Link>
        <span>/</span>
        <span className="text-charcoal">{parent.test_name}</span>
      </div>

      <div className="bg-surface border border-divider rounded-2xl p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-charcoal mb-1">{parent.test_name}</h1>
          <p className="text-soft-mute">Full-length SAT · Reading and Writing, then Math</p>
          {multiplier > 1 && (
            <p className="text-sm text-charcoal mt-1">Extended time: ×{multiplier} on every module</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl text-center">
            <Clock size={20} className="text-warm-coral-text mb-2" />
            <div className="text-charcoal font-semibold text-sm">{fmt(totalSeconds)}</div>
            <div className="text-soft-mute text-xs">Testing time + {breakMinutes} min break</div>
          </div>
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl">
            <BookOpen size={20} className="text-warm-coral-text mb-2" />
            <div className="text-charcoal font-semibold">{rw.m1Count + rw.m2Count + math.m1Count + math.m2Count}</div>
            <div className="text-soft-mute text-xs">Questions</div>
          </div>
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl">
            <Calendar size={20} className="text-warm-coral-text mb-2" />
            <div className="text-charcoal font-semibold text-sm">
              {parent.due_date ? formatDate(parent.due_date) : "No deadline"}
            </div>
            <div className="text-soft-mute text-xs">Due Date</div>
          </div>
        </div>

        <ol className="space-y-2 text-sm">
          <li className="flex justify-between gap-3 border-b border-divider pb-2">
            <span className="text-charcoal">Section 1 · Reading and Writing</span>
            <span className="text-soft-mute text-right">
              Module 1: {rw.m1Count} questions, {fmt(rw.m1Seconds)} · Module 2: {rw.m2Count} questions, {fmt(rw.m2Seconds)}
            </span>
          </li>
          <li className="flex justify-between gap-3 border-b border-divider pb-2">
            <span className="text-charcoal inline-flex items-center gap-1.5"><Coffee size={14} /> Break</span>
            <span className="text-soft-mute text-right">
              {breakMinutes} min{allowPause ? " · you may leave and continue later" : ""}
            </span>
          </li>
          <li className="flex justify-between gap-3">
            <span className="text-charcoal">Section 2 · Math</span>
            <span className="text-soft-mute text-right">
              Module 1: {math.m1Count} questions, {fmt(math.m1Seconds)} · Module 2: {math.m2Count} questions, {fmt(math.m2Seconds)}
            </span>
          </li>
        </ol>

        {st && open && (
          <p className="text-status-warning text-sm text-center">
            In progress: {flStateLabel(st)}
          </p>
        )}

        {open && mathBlocked ? (
          <div className="p-4 bg-status-error/10 border border-status-error/20 rounded-xl text-center text-status-error">
            This attempt is closed — Reading and Writing was submitted, but Math can&apos;t be started after the due date. Ask your teacher if you need to finish it.
          </div>
        ) : open ? (
          <div className="space-y-3">
            {!isAssigned && (
              <p className="text-soft-mute text-xs text-center">
                You can finish this attempt, but you&apos;re no longer assigned to this test.
              </p>
            )}
            <StartFullLengthButton testId={testId} label={st?.state === "break" ? "Continue to the break screen" : "Resume Test"} isResume />
          </div>
        ) : finished ? (
          <div className="space-y-3">
            <div className="p-4 bg-warm-amber/10 border border-warm-amber/20 rounded-xl text-center">
              {st?.state === "closed" ? (
                <div className="text-charcoal">
                  {attempt?.closed_reason === "math_not_started"
                    ? "This attempt is closed — Math wasn't started in time. Your Reading and Writing section is kept."
                    : attempt?.closed_reason === "abandoned"
                    ? "This attempt is closed — it can't be continued after the due date. Ask your teacher if you need to finish it."
                    : "This attempt is closed. Ask your teacher if you need to finish it."}
                </div>
              ) : (
                <div className="text-warm-amber font-semibold">Test submitted</div>
              )}
            </div>
            <Link
              href={`/student/tests/${testId}/result`}
              className="block w-full py-3 text-center rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold transition-colors"
            >
              View Result
            </Link>
            {canRetake && <StartFullLengthButton testId={testId} label="Retake Test" isResume={false} />}
          </div>
        ) : isPastDue ? (
          <div className="p-4 bg-status-error/10 border border-status-error/20 rounded-xl text-center text-status-error">
            This test is no longer available — the due date has passed.
          </div>
        ) : isNotOpenYet ? (
          <div className="p-4 bg-light-bg border border-divider rounded-xl text-center text-mid-gray">
            This test opens on {formatDateTime(parent.open_date as string)}.
            <RefreshAtOpenTime openAt={parent.open_date as string} serverNow={now} />
          </div>
        ) : canStartNew ? (
          <StartFullLengthButton testId={testId} isResume={false} />
        ) : (
          <div className="p-4 bg-light-bg border border-divider rounded-xl text-center text-mid-gray">
            This test isn&apos;t open right now.
          </div>
        )}

        {classReview.answers && (
          <Link
            href={`/student/tests/${testId}/review`}
            className="block w-full py-3 text-center rounded-xl border border-warm-amber/30 bg-warm-amber/10 text-warm-amber font-semibold transition-colors hover:bg-warm-amber/20"
          >
            Open class review (answers unlocked)
          </Link>
        )}
      </div>
    </div>
  );
}
