import { getServiceClient } from "@/lib/supabase";
import { fullLengthLinksOrNone, resolveParentTestId } from "@/lib/full-length";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { CheckCircle, XCircle, Clock, BarChart2, Printer } from "lucide-react";
import { clsx } from "clsx";
import { attemptScore } from "@/lib/score-display";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import { studentReportsEnabledFor } from "@/lib/student-reports";
import { getAnswerVisibility } from "@/lib/answer-visibility";
import AnswerReviewItem from "./AnswerReviewItem";
import FullLengthResult from "./FullLengthResult";

const TRACK_LABEL: Record<string, string> = {
  module_1: "Module 1",
  module_2: "Module 2",
  module_2_easy: "Module 2 · Easy",
  module_2_hard: "Module 2 · Hard",
};

type SessionRow = {
  id: string;
  status: string;
  percentage: number | null;
  correct_count: number | null;
  total_questions: number | null;
  scaled_score: number | null;
  session_id: string | null;
  adaptive_track: string | null;
  time_spent_seconds: number | null;
  started_at: string | null;
};

async function getResult(testId: string, studentId: string, submissionId?: string) {
  const db = getServiceClient();

  let query = db
    .from("submissions")
    .select(`
      id, status, score, correct_count, total_questions, percentage,
      started_at, submitted_at, time_spent_seconds, attempt_number,
      scaled_score, scaled_section, session_id, adaptive_track,
      tests!inner(
        test_name,
        modules!module_id(module_name, section)
      )
    `)
    .eq("test_id", testId)
    .eq("student_id", studentId)
    .in("status", ["Submitted", "Late"]);

  if (submissionId) {
    query = query.eq("id", submissionId);
  } else {
    query = query.order("attempt_number", { ascending: false }).limit(1);
  }

  const { data: submission } = await query.maybeSingle();
  if (!submission) return null;

  const test = submission.tests as unknown as { test_name: string; modules: { module_name: string; section: string } };

  // Answer/explanation reveal: the shared server-side decision (test
  // setting, per-student override, retake safety) — never the raw flags.
  // A teacher-opened class review counts here too: "View result" is where
  // students look, so it shows the questions while review is unlocked and
  // hides them again once it's locked (the decision still applies retake /
  // per-student hide rules).
  let visibility = await getAnswerVisibility(db, testId, studentId, "results");
  if (!visibility.answers) {
    const review = await getAnswerVisibility(db, testId, studentId, "class_review");
    if (review.answers) visibility = review;
  }

  // Adaptive sessions split the attempt across two submissions. Pull
  // the sibling row(s) so we can stitch a combined score card. We only
  // build the combined view when every row is graded — otherwise this
  // page is being viewed mid-attempt and the per-row card is what
  // matters.
  let sessionRows: SessionRow[] | null = null;
  const submissionWithSession = submission as typeof submission & {
    session_id?: string | null;
    adaptive_track?: string | null;
  };
  if (submissionWithSession.session_id) {
    const { data: rows } = await db
      .from("submissions")
      .select(
        "id, status, percentage, correct_count, total_questions, scaled_score, session_id, adaptive_track, time_spent_seconds, started_at",
      )
      .eq("session_id", submissionWithSession.session_id)
      .order("started_at", { ascending: true });
    sessionRows = (rows ?? []) as SessionRow[];
  }

  let answerDetails: {
    id: string;
    submission_id: string;
    question_id: string;
    student_answer: string | null;
    correct_answer: string | null;
    is_correct: boolean;
    questions: {
      original_question_number: number;
      question_text: string;
      choices: { label: string; text: string; image_url?: string | null }[];
      question_type: string;
      explanation: string | null;
      difficulty: string | null;
      module_id: string;
      has_image: boolean | null;
      has_table: boolean | null;
      image_urls: string[] | null;
      image_alts: string[] | null;
      page_number: number | null;
    };
  }[] | null = null;

  // For multi-submission sessions (two-module / adaptive) we surface
  // every module's answers in one review, grouped by module. For the
  // single-submission path we still only fetch the current submission.
  const reviewSubmissionIds: string[] = (() => {
    if (!visibility.answers) return [];
    if (sessionRows && sessionRows.length > 1) {
      return sessionRows
        .filter((r) => r.status === "Submitted" || r.status === "Late")
        .map((r) => r.id);
    }
    return [submission.id];
  })();

  if (reviewSubmissionIds.length > 0) {
    const { data: records } = await db
      .from("answer_records")
      .select(`
        id, submission_id, question_id, student_answer, correct_answer, is_correct,
        questions!inner(
          original_question_number, question_text, choices, question_type,
          explanation, difficulty, module_id, has_image, has_table,
          image_urls, image_alts, page_number
        )
      `)
      .in("submission_id", reviewSubmissionIds);

    answerDetails = records as typeof answerDetails ?? [];
    // Don't even hand explanations to the renderer when they're hidden.
    if (!visibility.explanations) {
      answerDetails = (answerDetails ?? []).map((r) => ({
        ...r,
        questions: { ...r.questions, explanation: null },
      }));
    }
    // Sort by submission order first (Module 1 before Module 2 by
    // started_at), then by original question number within each module.
    const orderIndex = new Map<string, number>(
      (sessionRows ?? [{ id: submission.id }]).map((r, i) => [r.id, i] as const),
    );
    answerDetails?.sort((a, b) => {
      const ao = orderIndex.get(a.submission_id) ?? 0;
      const bo = orderIndex.get(b.submission_id) ?? 0;
      if (ao !== bo) return ao - bo;
      return (
        (a.questions.original_question_number ?? 0) -
        (b.questions.original_question_number ?? 0)
      );
    });
  }

  // Score-breakdown rows — is_correct + each question's section/domain, for
  // EVERY graded submission in this attempt. Independent of the answer-reveal
  // gate: the aggregate strengths/weaknesses view is always safe to show, even
  // when per-question answers are hidden.
  const breakdownSubmissionIds =
    sessionRows && sessionRows.length > 0
      ? sessionRows.filter((r) => r.status === "Submitted" || r.status === "Late").map((r) => r.id)
      : [submission.id];
  const { data: breakdownRecords } = await db
    .from("answer_records")
    .select("is_correct, questions!inner(section, domain, skill)")
    .in("submission_id", breakdownSubmissionIds);
  const breakdownRows = ((breakdownRecords ?? []) as unknown as {
    is_correct: boolean;
    questions: { section: string | null; domain: string | null; skill: string | null };
  }[]).map((r) => ({
    is_correct: r.is_correct,
    section: r.questions?.section ?? null,
    domain: r.questions?.domain ?? null,
    skill: r.questions?.skill ?? null,
  }));

  return { submission, test, visibility, answerDetails, sessionRows, breakdownRows };
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

export default async function StudentResultPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ submission?: string; attempt?: string; section?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const { submission: submissionId, attempt: attemptParam, section: sectionParam } = await searchParams;
  // A full-length SAT section's result lives under its parent.
  const parentId = await resolveParentTestId(getServiceClient(), id);
  if (parentId !== id) {
    redirect(`/student/tests/${parentId}/result${submissionId ? `?submission=${encodeURIComponent(submissionId)}` : ""}`);
  }

  // Full-length SAT parent: one combined result over its two sections.
  const flKids = (await fullLengthLinksOrNone(getServiceClient())).childrenOf.get(id);
  if (flKids) {
    const db = getServiceClient();
    let attempt = attemptParam;
    let section = sectionParam;
    // A section submission id (old links, printouts) → its attempt and tab.
    if (submissionId && !attempt) {
      const { data: sub } = await db
        .from("submissions")
        .select("test_id, attempt_number")
        .eq("id", submissionId)
        .eq("student_id", user.userId)
        .maybeSingle();
      if (sub && (sub.test_id === flKids.rw || sub.test_id === flKids.math)) {
        attempt = String(sub.attempt_number ?? 1);
        section = section ?? (sub.test_id === flKids.math ? "math" : "rw");
      }
    }
    return (
      <FullLengthResult
        db={db}
        testId={id}
        studentId={user.userId}
        attemptParam={attempt}
        sectionParam={section}
        reportsEnabled={await studentReportsEnabledFor(db, user)}
      />
    );
  }

  const data = await getResult(id, user.userId, submissionId);
  if (!data) notFound();
  const reportsEnabled = await studentReportsEnabledFor(getServiceClient(), user);

  const { submission, test, visibility, answerDetails, sessionRows, breakdownRows } = data;
  // Same score display as everywhere else: SAT section score only once
  // every module is in, per-module correct counts, % as secondary text.
  const section = test.modules?.section ?? submission.scaled_section ?? null;
  const score = attemptScore(
    (sessionRows && sessionRows.length > 0 ? sessionRows : [submission]).map((r) => ({ ...r, student_id: user.userId })),
    section,
  ).score;

  // Partial state: a sibling submission in the same attempt is still
  // "In Progress" so the combined view can't render. We still want to
  // tell the student which module is missing instead of silently
  // showing only Module 1 with no explanation.
  const incompleteSiblings = (sessionRows ?? []).filter(
    (r) => r.status !== "Submitted" && r.status !== "Late",
  );
  const isPartialView =
    Array.isArray(sessionRows) &&
    sessionRows.length > 1 &&
    incompleteSiblings.length > 0;
  const incompleteLabels = incompleteSiblings
    .map((r) => TRACK_LABEL[r.adaptive_track ?? ""] ?? "another module")
    .join(", ");

  // Build the combined Module 1 + Module 2 view (stats + per-module
  // links) when this is a fully graded two-module session.
  const isAdaptiveSession =
    Array.isArray(sessionRows) &&
    sessionRows.length > 1 &&
    sessionRows.every((r) => r.status === "Submitted" || r.status === "Late");

  type SessionRowView = {
    id: string;
    label: string;
    correct: number;
    total: number;
    timeSeconds: number;
    isCurrent: boolean;
  };
  let combined: {
    correct: number;
    total: number;
    timeSeconds: number;
    module1: SessionRowView | null;
    module2: SessionRowView | null;
  } | null = null;

  if (isAdaptiveSession && sessionRows) {
    const totalCorrect = sessionRows.reduce((s, r) => s + (r.correct_count ?? 0), 0);
    const totalQs = sessionRows.reduce((s, r) => s + (r.total_questions ?? 0), 0);
    const combinedTime = sessionRows.reduce((s, r) => s + (r.time_spent_seconds ?? 0), 0);
    const view = (r: SessionRow): SessionRowView => ({
      id: r.id,
      label: TRACK_LABEL[r.adaptive_track ?? ""] ?? "Module",
      correct: r.correct_count ?? 0,
      total: r.total_questions ?? 0,
      timeSeconds: r.time_spent_seconds ?? 0,
      isCurrent: r.id === submission.id,
    });
    const m1 = sessionRows.find((r) => r.adaptive_track === "module_1") ?? null;
    // Non-adaptive two-module tests tag the second submission as
    // "module_2"; adaptive tests use "module_2_easy" / "module_2_hard".
    // All three are the Module 2 row for this session.
    const m2 = sessionRows.find(
      (r) =>
        r.adaptive_track === "module_2" ||
        r.adaptive_track === "module_2_easy" ||
        r.adaptive_track === "module_2_hard",
    ) ?? null;
    combined = {
      correct: totalCorrect,
      total: totalQs,
      timeSeconds: combinedTime,
      module1: m1 ? view(m1) : null,
      module2: m2 ? view(m2) : null,
    };
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/student/tests" className="hover:text-charcoal transition-colors">My Tests</Link>
        <span>/</span>
        <span className="text-charcoal">{test.test_name}</span>
        <span>/</span>
        <span className="text-charcoal">Result</span>
      </div>

      {isPartialView && (
        <div className="bg-warm-amber/10 border border-warm-amber/30 rounded-2xl p-5 flex items-start gap-3">
          <Clock size={20} className="text-warm-amber shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="text-charcoal font-semibold text-sm">
              Partial result — {incompleteLabels} not submitted yet
            </div>
            <div className="text-mid-gray text-xs leading-relaxed">
              You finished one module but the other is still open. The
              score below covers only the submitted module. Resume the
              test to complete it, or your teacher can release the
              full score once the remaining module is finalized.
            </div>
            <Link
              href={`/student/tests/${id}/take`}
              className="inline-block mt-2 px-3 py-1.5 rounded-lg bg-warm-amber/20 hover:bg-warm-amber/30 text-warm-amber text-xs font-medium transition-colors"
            >
              Resume remaining module
            </Link>
          </div>
        </div>
      )}

      {/* Score card — SAT section score once every module is in, then
          per-module correct counts; % correct is secondary. Two-module
          sessions also link to each module's own answers. */}
      <div className="bg-surface border border-divider rounded-2xl p-8 text-center space-y-4">
        <div className="text-soft-mute text-sm font-medium uppercase tracking-wider">
          {score?.sat != null ? `Estimated SAT score${section ? ` · ${section}` : ""}` : "Your Score"}
        </div>
        {score?.sat != null && (
          <div className="text-6xl font-bold text-charcoal">
            {score.sat}
            <span className="text-2xl text-soft-mute font-normal">/800</span>
          </div>
        )}
        <div className="text-charcoal text-lg">
          {score ? `${score.modules} correct` : "—"}
        </div>
        {score?.pct != null && (
          <div className="text-soft-mute text-xs">{score.pct.toFixed(1)}% correct</div>
        )}
        {score && score.notes.length > 0 && (
          <div className="text-status-warning text-xs">* {score.notes.join(" · ")}</div>
        )}
        {combined && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 text-left">
            {[combined.module1, combined.module2].filter((m): m is SessionRowView => !!m).map((m) => (
              <Link
                key={m.id}
                href={`/student/tests/${id}/result?submission=${m.id}`}
                className={clsx(
                  "block p-4 rounded-xl border transition-colors",
                  m.isCurrent
                    ? "border-warm-coral/40 bg-warm-coral/5"
                    : "border-divider hover:border-warm-coral/30",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-charcoal font-semibold text-sm">{m.label}</span>
                  <span className="text-mid-gray text-sm">
                    {m.correct}/{m.total} correct
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
        {submission.status === "Late" && (
          <div className="inline-block px-3 py-1 bg-status-warning/15 text-status-warning rounded-full text-xs font-medium">
            Submitted Late
          </div>
        )}
      </div>

      {/* Stats — combined when this is a multi-module session, else
          fall back to the single submission's numbers. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <CheckCircle size={20} className="text-warm-amber" />
          <div className="text-charcoal font-semibold">
            {combined ? combined.correct : submission.correct_count}
          </div>
          <div className="text-soft-mute text-xs">Correct</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <XCircle size={20} className="text-status-error" />
          <div className="text-charcoal font-semibold">
            {combined
              ? combined.total - combined.correct
              : (submission.total_questions ?? 0) - (submission.correct_count ?? 0)}
          </div>
          <div className="text-soft-mute text-xs">Incorrect</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <Clock size={20} className="text-warm-coral-text" />
          <div className="text-charcoal font-semibold text-sm">
            {formatDuration(combined ? combined.timeSeconds : submission.time_spent_seconds)}
          </div>
          <div className="text-soft-mute text-xs">Time Spent</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <BarChart2 size={20} className="text-warm-coral-text" />
          <div className="text-charcoal font-semibold">#{submission.attempt_number}</div>
          <div className="text-soft-mute text-xs">Attempt</div>
        </div>
      </div>

      {/* Strengths & weaknesses by SAT domain — always shown (aggregate,
          no per-question reveal). Template-generated report, no AI. */}
      {breakdownRows && breakdownRows.length > 0 && (
        <ScoreBreakdown rows={breakdownRows} title="Your Strengths & Focus Areas" />
      )}

      {/* Answer review — grouped by module when this is a multi-module
          session so both Module 1 and Module 2 answers show up under
          one page instead of just the current submission's. */}
      {answerDetails && answerDetails.length > 0 && (() => {
        const useGroups = Boolean(combined) && Array.isArray(sessionRows) && sessionRows.length > 1;
        const groups: { key: string; label: string | null; records: typeof answerDetails }[] = [];
        if (useGroups && sessionRows) {
          for (const row of sessionRows) {
            const recs = answerDetails!.filter((r) => r.submission_id === row.id);
            if (recs.length === 0) continue;
            groups.push({
              key: row.id,
              label: TRACK_LABEL[row.adaptive_track ?? ""] ?? "Module",
              records: recs,
            });
          }
        } else {
          groups.push({ key: "all", label: null, records: answerDetails! });
        }
        return (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-charcoal font-semibold text-lg">Answer Review</h2>
            <a
              href={`/print/results/${id}?subs=${submission.id}`}
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-light-bg hover:bg-divider text-charcoal text-xs font-semibold transition-colors print:hidden"
            >
              <Printer size={13} />
              Print
            </a>
          </div>
          {groups.map((group) => (
          <div key={group.key} className="space-y-3">
            {group.label && (
              <div className="text-soft-mute text-xs font-semibold uppercase tracking-wider pt-2">
                {group.label}
              </div>
            )}
            {group.records.map((record) => (
              <AnswerReviewItem key={record.id} record={record} visibility={visibility} reportsEnabled={reportsEnabled} testId={id} />
            ))}
          </div>
          ))}
        </div>
        );
      })()}

      {!answerDetails && (
        <div className="p-4 bg-surface border border-divider rounded-xl text-center text-soft-mute text-sm">
          Detailed answer review is not available for this test.
        </div>
      )}

      <div className="flex justify-center">
        <Link
          href="/student/tests"
          className="px-6 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal hover:border-divider transition-colors text-sm"
        >
          Back to Tests
        </Link>
      </div>
    </div>
  );
}
