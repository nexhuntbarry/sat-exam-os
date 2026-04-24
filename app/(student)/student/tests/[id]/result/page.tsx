import { getServiceClient } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { CheckCircle, XCircle, Clock, BarChart2 } from "lucide-react";
import { clsx } from "clsx";

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
      <div className="flex items-center gap-2 text-soft-gray/50 text-sm">
        <Link href="/student/tests" className="hover:text-soft-gray transition-colors">My Tests</Link>
        <span>/</span>
        <span className="text-white">{test.test_name}</span>
        <span>/</span>
        <span className="text-white">Result</span>
      </div>

      {/* Score card */}
      <div className="bg-white/3 border border-white/8 rounded-2xl p-8 text-center space-y-4">
        <div className="text-soft-gray/50 text-sm font-medium uppercase tracking-wider">Your Score</div>
        <div className={clsx(
          "text-6xl font-bold",
          pct >= 80 ? "text-lime-green" : pct >= 60 ? "text-amber" : "text-rose"
        )}>
          {pct.toFixed(1)}%
        </div>
        <div className="text-white text-lg">
          {submission.correct_count} / {submission.total_questions} correct
        </div>
        {submission.status === "Late" && (
          <div className="inline-block px-3 py-1 bg-amber/15 text-amber rounded-full text-xs font-medium">
            Submitted Late
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white/3 border border-white/8 rounded-xl p-4 flex flex-col items-center gap-1">
          <CheckCircle size={20} className="text-lime-green" />
          <div className="text-white font-semibold">{submission.correct_count}</div>
          <div className="text-soft-gray/50 text-xs">Correct</div>
        </div>
        <div className="bg-white/3 border border-white/8 rounded-xl p-4 flex flex-col items-center gap-1">
          <XCircle size={20} className="text-rose" />
          <div className="text-white font-semibold">{(submission.total_questions ?? 0) - (submission.correct_count ?? 0)}</div>
          <div className="text-soft-gray/50 text-xs">Incorrect</div>
        </div>
        <div className="bg-white/3 border border-white/8 rounded-xl p-4 flex flex-col items-center gap-1">
          <Clock size={20} className="text-electric-blue" />
          <div className="text-white font-semibold text-sm">{formatDuration(submission.time_spent_seconds)}</div>
          <div className="text-soft-gray/50 text-xs">Time Spent</div>
        </div>
        <div className="bg-white/3 border border-white/8 rounded-xl p-4 flex flex-col items-center gap-1">
          <BarChart2 size={20} className="text-electric-blue" />
          <div className="text-white font-semibold">#{submission.attempt_number}</div>
          <div className="text-soft-gray/50 text-xs">Attempt</div>
        </div>
      </div>

      {/* Answer review */}
      {answerDetails && answerDetails.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-white font-semibold text-lg">Answer Review</h2>
          <div className="space-y-3">
            {answerDetails.map((record) => {
              const q = record.questions;
              return (
                <details key={record.id} className="bg-white/3 border border-white/8 rounded-xl overflow-hidden group">
                  <summary className="flex items-center gap-3 p-4 cursor-pointer hover:bg-white/4 transition-colors list-none">
                    <div className={clsx(
                      "w-6 h-6 rounded-full flex items-center justify-center shrink-0",
                      record.is_correct ? "bg-lime-green/20" : "bg-rose/20"
                    )}>
                      {record.is_correct
                        ? <CheckCircle size={14} className="text-lime-green" />
                        : <XCircle size={14} className="text-rose" />
                      }
                    </div>
                    <span className="text-soft-gray/50 text-sm shrink-0">Q{q.original_question_number}</span>
                    <span className="text-white text-sm line-clamp-1 flex-1">{q.question_text}</span>
                    <span className={clsx(
                      "text-xs font-medium shrink-0",
                      record.is_correct ? "text-lime-green" : "text-rose"
                    )}>
                      {record.is_correct ? "Correct" : "Incorrect"}
                    </span>
                  </summary>
                  <div className="px-4 pb-4 pt-2 space-y-3 border-t border-white/8">
                    <p className="text-white text-sm whitespace-pre-wrap">{q.question_text}</p>

                    {q.question_type === "Multiple Choice" && (q.choices ?? []).length > 0 && (
                      <div className="space-y-1.5">
                        {(q.choices as { label: string; text: string }[]).map((c) => (
                          <div
                            key={c.label}
                            className={clsx(
                              "flex items-start gap-2.5 p-2.5 rounded-lg text-sm",
                              c.label === record.correct_answer
                                ? "bg-lime-green/10 border border-lime-green/20 text-lime-green"
                                : c.label === record.student_answer && !record.is_correct
                                ? "bg-rose/10 border border-rose/20 text-rose"
                                : "text-soft-gray/50"
                            )}
                          >
                            <span className="font-semibold shrink-0">{c.label}.</span>
                            <span>{c.text}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {q.question_type === "Student Produced Response" && (
                      <div className="space-y-1">
                        <div className="text-soft-gray/50 text-xs">Your answer: <span className={record.is_correct ? "text-lime-green" : "text-rose"}>{record.student_answer ?? "—"}</span></div>
                        <div className="text-soft-gray/50 text-xs">Correct answer: <span className="text-lime-green">{record.correct_answer}</span></div>
                      </div>
                    )}

                    {q.explanation && (
                      <div className="p-3 bg-electric-blue/5 border border-electric-blue/15 rounded-lg">
                        <div className="text-electric-blue text-xs font-medium mb-1">Explanation</div>
                        <p className="text-soft-gray/70 text-sm">{q.explanation}</p>
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
        <div className="p-4 bg-white/3 border border-white/8 rounded-xl text-center text-soft-gray/40 text-sm">
          Detailed answer review is not available for this test.
        </div>
      )}

      <div className="flex justify-center">
        <Link
          href="/student/tests"
          className="px-6 py-2.5 rounded-xl border border-white/10 text-soft-gray/70 hover:text-soft-gray hover:border-white/20 transition-colors text-sm"
        >
          Back to Tests
        </Link>
      </div>
    </div>
  );
}
