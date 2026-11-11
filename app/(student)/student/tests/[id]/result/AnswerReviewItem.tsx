import { CheckCircle, XCircle } from "lucide-react";
import { clsx } from "clsx";
import MathMarkdown from "@/components/MathMarkdown";
import ReportProblemButton from "@/components/tests/ReportProblemButton";
import { acceptedAnswersText, sprEntryFeedback } from "@/lib/answer-key";

// One question of a student's answer review (the result page). Shared by
// the section-test result and the full-length SAT result's section tabs.

export interface AnswerDetail {
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
}

export default function AnswerReviewItem({
  record,
  visibility,
  reportsEnabled,
  testId,
}: {
  record: AnswerDetail;
  visibility: { explanations: boolean };
  reportsEnabled: boolean;
  /** The test the submission belongs to (a full-length section's own id). */
  testId: string;
}) {
  const q = record.questions;
  return (
    <details data-print-open className="bg-surface border border-divider rounded-xl overflow-hidden group">
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

        {/* Question figure: recovered crop(s) only — students never see the
            raw source scan page (M-20). Not lazy: a lazy figure inside a closed
            row never loads, so Ctrl/Cmd+P printed the review without diagrams. */}
        {q.image_urls && q.image_urls.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {q.image_urls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={url}
                src={`/api/blob-image?u=${encodeURIComponent(url)}`}
                alt={q.image_alts?.[i] || `Figure for question ${q.original_question_number}`}
                className="max-w-full md:max-w-lg rounded-xl border border-divider bg-white"
              />
            ))}
          </div>
        )}

        {q.question_type === "Multiple Choice" && (q.choices ?? []).length > 0 && (
          <div className="space-y-1.5">
            {(q.choices as { label: string; text: string; image_url?: string | null }[]).map((c) => (
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
                <div className="min-w-0">
                  {c.text && <MathMarkdown className="prose prose-sm max-w-none text-inherit [&_p]:my-0">{c.text}</MathMarkdown>}
                  {c.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/blob-image?u=${encodeURIComponent(c.image_url)}`}
                      alt={`Choice ${c.label} graph`}
                      className="max-w-full max-h-60 rounded-lg border border-divider bg-white mt-1"
                    />
                  )}
                </div>
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
            {/* Official fill-in rules: every entry that counts, and why
                this one didn't (only rendered where answers are shown). */}
            {record.correct_answer && (
              <div className="text-soft-mute text-xs">
                Accepted answers:{" "}
                <span className="text-charcoal font-mono">{acceptedAnswersText(record.correct_answer, q.question_text)}</span>
              </div>
            )}
            {!record.is_correct && sprEntryFeedback(record.student_answer, record.correct_answer, q.question_text) && (
              <div className="text-status-warning text-xs">
                {sprEntryFeedback(record.student_answer, record.correct_answer, q.question_text)}
              </div>
            )}
          </div>
        )}

        {visibility.explanations && q.explanation && (
          <div className="p-3 bg-warm-coral/5 border border-warm-coral/15 rounded-lg">
            <div className="text-warm-coral-text text-xs font-medium mb-1">Explanation</div>
            <MathMarkdown className="prose prose-sm max-w-none text-mid-gray [&_p]:my-1.5 [&_p]:leading-relaxed">
              {q.explanation}
            </MathMarkdown>
          </div>
        )}

        {reportsEnabled && (
          <div className="flex justify-end">
            <ReportProblemButton
              testId={testId}
              submissionId={record.submission_id}
              questionId={record.question_id}
              context="results"
            />
          </div>
        )}
      </div>
    </details>
  );
}
