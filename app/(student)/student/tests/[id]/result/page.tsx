import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { CheckCircle, XCircle, Clock, BarChart2 } from "lucide-react";
import { clsx } from "clsx";
import MathMarkdown from "@/components/MathMarkdown";
import { scaleSectionScore } from "@/lib/scoring";

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
  adaptive_track: string | null;
  time_spent_seconds: number | null;
};

async function getResult(testId: string, studentId: string, submissionId?: string) {
  const db = getServiceClient();

  let query = db
    .from("submissions")
    .select(`
      id, status, score, correct_count, total_questions, percentage,
      started_at, submitted_at, time_spent_seconds, attempt_number,
      scaled_score, scaled_section,
      tests!inner(
        test_name, show_answers_after_submission,
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

  const test = submission.tests as unknown as { test_name: string; show_answers_after_submission: boolean; modules: { module_name: string; section: string } };

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
        "id, status, percentage, correct_count, total_questions, scaled_score, adaptive_track, time_spent_seconds, started_at",
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
      choices: { label: string; text: string }[];
      question_type: string;
      explanation: string | null;
      difficulty: string | null;
    };
  }[] | null = null;

  // For multi-submission sessions (two-module / adaptive) we surface
  // every module's answers in one review, grouped by module. For the
  // single-submission path we still only fetch the current submission.
  const reviewSubmissionIds: string[] = (() => {
    if (!test.show_answers_after_submission) return [];
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
          explanation, difficulty
        )
      `)
      .in("submission_id", reviewSubmissionIds);

    answerDetails = records as typeof answerDetails ?? [];
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

  return { submission, test, answerDetails, sessionRows };
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
  searchParams: Promise<{ submission?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const { submission: submissionId } = await searchParams;

  const data = await getResult(id, user.userId, submissionId);
  if (!data) notFound();

  const { submission, test, answerDetails, sessionRows } = data;
  const pct = Number(submission.percentage ?? 0);

  // Build the combined Module 1 + Module 2 view when this is a fully
  // graded adaptive session. We weight by raw counts (not by averaging
  // percentages) so an unequal-sized Module 2 doesn't distort the
  // headline score, then run the result through scaleSectionScore so
  // the 200..800 estimate accounts for the harder/easier module the
  // student was routed to.
  const isAdaptiveSession =
    Array.isArray(sessionRows) &&
    sessionRows.length > 1 &&
    sessionRows.every((r) => r.status === "Submitted" || r.status === "Late");

  type SessionRowView = {
    id: string;
    label: string;
    correct: number;
    total: number;
    percentage: number;
    scaled: number | null;
    timeSeconds: number;
    isCurrent: boolean;
  };
  let combined: {
    correct: number;
    total: number;
    pct: number;
    scaled: number;
    timeSeconds: number;
    module1: SessionRowView | null;
    module2: SessionRowView | null;
  } | null = null;

  if (isAdaptiveSession && sessionRows) {
    const totalCorrect = sessionRows.reduce((s, r) => s + (r.correct_count ?? 0), 0);
    const totalQs = sessionRows.reduce((s, r) => s + (r.total_questions ?? 0), 0);
    const combinedPct = totalQs > 0
      ? Math.round((totalCorrect / totalQs) * 100 * 10) / 10
      : 0;
    const combinedScaled = scaleSectionScore(combinedPct);
    const combinedTime = sessionRows.reduce((s, r) => s + (r.time_spent_seconds ?? 0), 0);
    const view = (r: SessionRow): SessionRowView => ({
      id: r.id,
      label: TRACK_LABEL[r.adaptive_track ?? ""] ?? "Module",
      correct: r.correct_count ?? 0,
      total: r.total_questions ?? 0,
      percentage: Number(r.percentage ?? 0),
      scaled: r.scaled_score ?? null,
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
      pct: combinedPct,
      scaled: combinedScaled,
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

      {/* Score card — adaptive flow shows the combined Module 1 +
          Module 2 view; legacy single-module flow keeps the original
          per-submission card. */}
      {combined ? (
        <div className="bg-surface border border-divider rounded-2xl p-8 text-center space-y-4">
          <div className="text-soft-mute text-sm font-medium uppercase tracking-wider">
            Your Score · Combined
          </div>
          <div className={clsx(
            "text-6xl font-bold",
            combined.pct >= 80 ? "text-warm-amber" : combined.pct >= 60 ? "text-status-warning" : "text-status-error",
          )}>
            {combined.pct.toFixed(1)}%
          </div>
          <div className="text-charcoal text-lg">
            {combined.correct} / {combined.total} correct
          </div>
          <div className="inline-flex flex-col items-center gap-1 px-6 py-3 rounded-2xl bg-warm-coral/10 border border-warm-coral/20">
            <span className="text-soft-mute text-xs uppercase tracking-wider">
              Estimated SAT score{submission.scaled_section ? ` · ${submission.scaled_section}` : ""}
            </span>
            <span className="text-warm-coral text-3xl font-bold">
              {combined.scaled}
              <span className="text-base text-soft-mute font-normal">/800</span>
            </span>
            <span className="text-soft-mute text-[10px] italic">
              estimate — combines Module 1 + Module 2 raw counts
            </span>
          </div>
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
                  <span className="text-warm-coral text-sm font-semibold">
                    {m.percentage.toFixed(1)}%
                  </span>
                </div>
                <div className="text-soft-mute text-xs mt-1">
                  {m.correct} / {m.total} correct
                </div>
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-surface border border-divider rounded-2xl p-8 text-center space-y-4">
          <div className="text-soft-mute text-sm font-medium uppercase tracking-wider">Your Score</div>
          <div className={clsx(
            "text-6xl font-bold",
            pct >= 80 ? "text-warm-amber" : pct >= 60 ? "text-status-warning" : "text-status-error"
          )}>
            {pct.toFixed(1)}%
          </div>
          <div className="text-charcoal text-lg">
            {submission.correct_count} / {submission.total_questions} correct
          </div>
          {submission.scaled_score != null && (
            <div className="inline-flex flex-col items-center gap-1 px-6 py-3 rounded-2xl bg-warm-coral/10 border border-warm-coral/20">
              <span className="text-soft-mute text-xs uppercase tracking-wider">
                Estimated SAT score{submission.scaled_section ? ` · ${submission.scaled_section}` : ""}
              </span>
              <span className="text-warm-coral text-3xl font-bold">
                {submission.scaled_score}
                <span className="text-base text-soft-mute font-normal">/800</span>
              </span>
              <span className="text-soft-mute text-[10px] italic">
                estimate — not adaptive scoring
              </span>
            </div>
          )}
          {submission.status === "Late" && (
            <div className="inline-block px-3 py-1 bg-status-warning/15 text-status-warning rounded-full text-xs font-medium">
              Submitted Late
            </div>
          )}
        </div>
      )}

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
          <Clock size={20} className="text-warm-coral" />
          <div className="text-charcoal font-semibold text-sm">
            {formatDuration(combined ? combined.timeSeconds : submission.time_spent_seconds)}
          </div>
          <div className="text-soft-mute text-xs">Time Spent</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <BarChart2 size={20} className="text-warm-coral" />
          <div className="text-charcoal font-semibold">#{submission.attempt_number}</div>
          <div className="text-soft-mute text-xs">Attempt</div>
        </div>
      </div>

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
          <h2 className="text-charcoal font-semibold text-lg">Answer Review</h2>
          {groups.map((group) => (
          <div key={group.key} className="space-y-3">
            {group.label && (
              <div className="text-soft-mute text-xs font-semibold uppercase tracking-wider pt-2">
                {group.label}
              </div>
            )}
            {group.records.map((record) => {
              const q = record.questions;
              return (
                <details key={record.id} className="bg-surface border border-divider rounded-xl overflow-hidden group">
                  <summary className="flex items-center gap-3 p-4 cursor-pointer hover:bg-surface transition-colors list-none">
                    <div className={clsx(
                      "w-6 h-6 rounded-full flex items-center justify-center shrink-0",
                      record.is_correct ? "bg-status-success/20" : "bg-status-error/15"
                    )}>
                      {record.is_correct
                        ? <CheckCircle size={14} className="text-status-success" />
                        : <XCircle size={14} className="text-status-error" />
                      }
                    </div>
                    <span className="text-soft-mute text-sm shrink-0">Q{q.original_question_number}</span>
                    <MathMarkdown className="text-charcoal text-sm line-clamp-1 flex-1 prose prose-sm max-w-none [&_p]:my-0">{q.question_text}</MathMarkdown>
                    <span className={clsx(
                      "text-xs font-medium shrink-0",
                      record.is_correct
                        ? "text-status-success"
                        : !record.student_answer || record.student_answer.trim() === ""
                        ? "text-status-warning"
                        : "text-status-error"
                    )}>
                      {record.is_correct
                        ? "Correct"
                        : !record.student_answer || record.student_answer.trim() === ""
                        ? "Blank"
                        : "Incorrect"}
                    </span>
                  </summary>
                  <div className="px-4 pb-4 pt-2 space-y-3 border-t border-divider">
                    <MathMarkdown className="text-charcoal text-sm prose prose-sm max-w-none [&_p]:my-2">
                      {q.question_text}
                    </MathMarkdown>

                    {q.question_type === "Multiple Choice" && (q.choices ?? []).length > 0 && (
                      <div className="space-y-1.5">
                        {(q.choices as { label: string; text: string }[]).map((c) => (
                          <div
                            key={c.label}
                            className={clsx(
                              "flex items-start gap-2.5 p-2.5 rounded-lg text-sm",
                              c.label === record.correct_answer
                                ? "bg-status-success/10 border border-status-success/30 text-status-success"
                                : c.label === record.student_answer && !record.is_correct
                                ? "bg-status-error/10 border border-status-error/20 text-status-error"
                                : "text-soft-mute"
                            )}
                          >
                            <span className="font-semibold shrink-0">{c.label}.</span>
                            <MathMarkdown className="prose prose-sm max-w-none text-inherit [&_p]:my-0">{c.text}</MathMarkdown>
                          </div>
                        ))}
                      </div>
                    )}

                    {q.question_type === "Student Produced Response" && (
                      <div className="space-y-1">
                        <div className="text-soft-mute text-xs">
                          Your answer:{" "}
                          {record.student_answer && record.student_answer.trim() !== "" ? (
                            <span className={record.is_correct ? "text-status-success" : "text-status-error"}>
                              {record.student_answer}
                            </span>
                          ) : (
                            <span className="text-status-warning italic">Blank</span>
                          )}
                        </div>
                        <div className="text-soft-mute text-xs">Correct answer: <span className="text-status-success">{record.correct_answer}</span></div>
                      </div>
                    )}

                    {q.explanation && (
                      <div className="p-3 bg-warm-coral/5 border border-warm-coral/15 rounded-lg">
                        <div className="text-warm-coral text-xs font-medium mb-1">Explanation</div>
                        <MathMarkdown className="prose prose-sm max-w-none text-mid-gray [&_p]:my-1.5 [&_p]:leading-relaxed">
                          {q.explanation}
                        </MathMarkdown>
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
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
