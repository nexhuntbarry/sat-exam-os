import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { CheckCircle, XCircle, Clock, BarChart2 } from "lucide-react";
import { clsx } from "clsx";
import MathMarkdown from "@/components/MathMarkdown";

async function getResult(testId: string, studentId: string, submissionId?: string) {
  const db = getServiceClient();

  let query = db
    .from("submissions")
    .select(`
      id, status, score, correct_count, total_questions, percentage,
      started_at, submitted_at, time_spent_seconds, attempt_number,
      tests!inner(
        test_name, show_answers_after_submission,
        modules!inner(module_name, section)
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

  let answerDetails: {
    id: string;
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

  if (test.show_answers_after_submission) {
    const { data: records } = await db
      .from("answer_records")
      .select(`
        id, question_id, student_answer, correct_answer, is_correct,
        questions!inner(
          original_question_number, question_text, choices, question_type,
          explanation, difficulty
        )
      `)
      .eq("submission_id", submission.id);

    answerDetails = records as typeof answerDetails ?? [];
    // Sort by question number
    answerDetails?.sort(
      (a, b) =>
        (a.questions.original_question_number ?? 0) - (b.questions.original_question_number ?? 0)
    );
  }

  return { submission, test, answerDetails };
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

  const { submission, test, answerDetails } = data;
  const pct = Number(submission.percentage ?? 0);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-2 text-soft-mute text-sm">
        <Link href="/student/tests" className="hover:text-charcoal transition-colors">My Tests</Link>
        <span>/</span>
        <span className="text-charcoal">{test.test_name}</span>
        <span>/</span>
        <span className="text-charcoal">Result</span>
      </div>

      {/* Score card */}
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
        {submission.status === "Late" && (
          <div className="inline-block px-3 py-1 bg-status-warning/15 text-status-warning rounded-full text-xs font-medium">
            Submitted Late
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <CheckCircle size={20} className="text-warm-amber" />
          <div className="text-charcoal font-semibold">{submission.correct_count}</div>
          <div className="text-soft-mute text-xs">Correct</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <XCircle size={20} className="text-status-error" />
          <div className="text-charcoal font-semibold">{(submission.total_questions ?? 0) - (submission.correct_count ?? 0)}</div>
          <div className="text-soft-mute text-xs">Incorrect</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <Clock size={20} className="text-warm-coral" />
          <div className="text-charcoal font-semibold text-sm">{formatDuration(submission.time_spent_seconds)}</div>
          <div className="text-soft-mute text-xs">Time Spent</div>
        </div>
        <div className="bg-surface border border-divider rounded-xl p-4 flex flex-col items-center gap-1">
          <BarChart2 size={20} className="text-warm-coral" />
          <div className="text-charcoal font-semibold">#{submission.attempt_number}</div>
          <div className="text-soft-mute text-xs">Attempt</div>
        </div>
      </div>

      {/* Answer review */}
      {answerDetails && answerDetails.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-charcoal font-semibold text-lg">Answer Review</h2>
          <div className="space-y-3">
            {answerDetails.map((record) => {
              const q = record.questions;
              return (
                <details key={record.id} className="bg-surface border border-divider rounded-xl overflow-hidden group">
                  <summary className="flex items-center gap-3 p-4 cursor-pointer hover:bg-surface transition-colors list-none">
                    <div className={clsx(
                      "w-6 h-6 rounded-full flex items-center justify-center shrink-0",
                      record.is_correct ? "bg-warm-amber/20" : "bg-status-error/15"
                    )}>
                      {record.is_correct
                        ? <CheckCircle size={14} className="text-warm-amber" />
                        : <XCircle size={14} className="text-status-error" />
                      }
                    </div>
                    <span className="text-soft-mute text-sm shrink-0">Q{q.original_question_number}</span>
                    <MathMarkdown className="text-charcoal text-sm line-clamp-1 flex-1 prose prose-sm max-w-none [&_p]:my-0">{q.question_text}</MathMarkdown>
                    <span className={clsx(
                      "text-xs font-medium shrink-0",
                      record.is_correct ? "text-warm-amber" : "text-status-error"
                    )}>
                      {record.is_correct ? "Correct" : "Incorrect"}
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
                                ? "bg-warm-amber/10 border border-warm-amber/20 text-warm-amber"
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
                        <div className="text-soft-mute text-xs">Your answer: <span className={record.is_correct ? "text-warm-amber" : "text-status-error"}>{record.student_answer ?? "—"}</span></div>
                        <div className="text-soft-mute text-xs">Correct answer: <span className="text-warm-amber">{record.correct_answer}</span></div>
                      </div>
                    )}

                    {q.explanation && (
                      <div className="p-3 bg-warm-coral/5 border border-warm-coral/15 rounded-lg">
                        <div className="text-warm-coral text-xs font-medium mb-1">Explanation</div>
                        <p className="text-mid-gray text-sm">{q.explanation}</p>
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      )}

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
