import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Clock, BookOpen, Calendar } from "lucide-react";
import StartTestButton from "./StartTestButton";
import { formatDate, formatDateTime } from "@/lib/datetime";

async function getTestInfo(testId: string, studentId: string) {
  const db = getServiceClient();

  // Check student has access
  const { data: membership } = await db
    .from("class_group_members")
    .select("class_group_id")
    .eq("student_id", studentId);
  const classGroupIds = (membership ?? []).map((m) => m.class_group_id);

  const { data: assignment } = await db
    .from("test_assignments")
    .select("test_id, student_ids, class_group_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) return null;
  const sIds: string[] = assignment.student_ids ?? [];
  const cgIds: string[] = assignment.class_group_ids ?? [];
  const hasAccess = sIds.includes(studentId) || classGroupIds.some((cg) => cgIds.includes(cg));
  if (!hasAccess) return null;

  const { data: test } = await db
    .from("tests")
    .select(`
      id, test_name, status, time_limit_minutes, time_limit_minutes_module_2,
      due_date, open_date,
      allow_retake, show_answers_after_submission, module_id, module_2_id,
      is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, review_unlocked,
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

  // Approved question count — for two-module tests we sum Module 1 +
  // Module 2 counts so the student sees the full attempt size, not
  // half of it.
  const m1ModuleId = test.is_adaptive ? test.module_1_id : test.module_id;
  const m2ModuleId = test.is_adaptive ? test.module_2_easy_id : test.module_2_id;
  const [{ count: m1Count }, { count: m2Count }] = await Promise.all([
    m1ModuleId
      ? db
          .from("questions")
          .select("id", { count: "exact", head: true })
          .eq("module_id", m1ModuleId)
          .neq("parsing_status", "Rejected")
      : Promise.resolve({ count: 0 }),
    m2ModuleId
      ? db
          .from("questions")
          .select("id", { count: "exact", head: true })
          .eq("module_id", m2ModuleId)
          .neq("parsing_status", "Rejected")
      : Promise.resolve({ count: 0 }),
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
  if (subs && subs.length > 0) {
    const latestAttempt = subs[0].attempt_number;
    const sessionRows = subs.filter((s) => s.attempt_number === latestAttempt);
    const allSubmitted = sessionRows.every(
      (s) => s.status === "Submitted" || s.status === "Late",
    );
    if (sessionRows.length > 1 && allSubmitted) {
      const correct = sessionRows.reduce((a, s) => a + (s.correct_count ?? 0), 0);
      const total = sessionRows.reduce((a, s) => a + (s.total_questions ?? 0), 0);
      combinedPct = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
    }
    // Headline submission row: prefer the most recently submitted
    // row so the "View Result" link routes the student to a fully
    // graded submission. In Progress falls back to whichever is open.
    const sorted = [...sessionRows].sort((a, b) => {
      if (a.submitted_at && b.submitted_at)
        return b.submitted_at.localeCompare(a.submitted_at);
      if (a.submitted_at) return -1;
      if (b.submitted_at) return 1;
      return 0;
    });
    submission = {
      id: sorted[0].id,
      status: sorted[0].status,
      percentage: sorted[0].percentage != null ? Number(sorted[0].percentage) : null,
      submitted_at: sorted[0].submitted_at,
    };
  }

  return {
    test,
    questionCount: totalQuestionCount,
    submission,
    module2Meta,
    isTwoModule,
    combinedPct,
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
  const data = await getTestInfo(id, user.userId);
  if (!data) notFound();

  const { test, questionCount, submission, module2Meta, isTwoModule, combinedPct } = data;
  const mod = test.modules as unknown as
    | { module_name: string; section: string; module_number: number | null }
    | null;
  const m1Limit = test.time_limit_minutes;
  const m2Limit = test.time_limit_minutes_module_2 ?? m1Limit;
  const timeLimitDisplay = isTwoModule && m1Limit
    ? `${m1Limit} + ${m2Limit} min`
    : m1Limit
    ? `${m1Limit} min`
    : "—";

  const isPastDue = test.due_date && new Date(test.due_date) < new Date();
  const isInProgress = submission?.status === "In Progress";
  const isSubmitted = submission?.status === "Submitted" || submission?.status === "Late";
  const canRetake = test.allow_retake && isSubmitted;

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
            <Clock size={20} className="text-warm-coral mb-2" />
            <div className="text-charcoal font-semibold">{timeLimitDisplay}</div>
            <div className="text-soft-mute text-xs">Time Limit</div>
          </div>
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl">
            <BookOpen size={20} className="text-warm-coral mb-2" />
            <div className="text-charcoal font-semibold">{questionCount}</div>
            <div className="text-soft-mute text-xs">Questions</div>
          </div>
          <div className="flex flex-col items-center p-4 bg-surface border border-divider rounded-xl">
            <Calendar size={20} className="text-warm-coral mb-2" />
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
                Test Submitted{isTwoModule ? " · combined" : ""}
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
        ) : isPastDue && !isInProgress ? (
          <div className="p-4 bg-status-error/10 border border-status-error/20 rounded-xl text-center text-status-error">
            This test is no longer available — the due date has passed.
          </div>
        ) : (
          <div className="space-y-3">
            {isInProgress && (
              <p className="text-status-warning text-sm text-center">
                You have an in-progress submission. Resuming will continue from where you left off.
              </p>
            )}
            <StartTestButton
              testId={test.id}
              submissionId={isInProgress ? submission?.id : undefined}
              isResume={isInProgress}
            />
          </div>
        )}

        {Boolean((test as { review_unlocked?: boolean }).review_unlocked) && (
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
