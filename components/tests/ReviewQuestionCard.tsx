import { clsx } from "clsx";
import MathMarkdown from "@/components/MathMarkdown";

// One question as shown in a REVIEW walkthrough (student class-review and
// teacher class-review both render through this so they can never drift
// apart again — the earlier bug was each page hand-rolling its own
// rendering and forgetting choices / figures).
export interface ReviewQuestion {
  id: string;
  module_id: string;
  original_question_number: number;
  question_text: string;
  choices: { label: string; text: string }[] | null;
  question_type: "Multiple Choice" | "Student Produced Response" | string;
  correct_answer: string | null;
  explanation: string | null;
  has_image?: boolean | null;
  has_table?: boolean | null;
  image_urls?: string[] | null;
  image_alts?: string[] | null;
  page_number?: number | null;
  source_pdf_url?: string | null;
}

interface Props {
  question: ReviewQuestion;
  /** The viewer's own submitted answer (student review). */
  mine?: { answer: string | null; isCorrect: boolean } | null;
  /** Whether to show the worked explanation. Defaults to true. */
  showExplanation?: boolean;
  /** Teacher review: names of students who got this question wrong. */
  wrongStudents?: string[];
}

export default function ReviewQuestionCard({
  question: q,
  mine,
  showExplanation = true,
  wrongStudents,
}: Props) {
  const choices = Array.isArray(q.choices) ? q.choices : [];
  const hasCrops = Array.isArray(q.image_urls) && q.image_urls.length > 0;
  const needsFigureFallback = (q.has_image || q.has_table) && !hasCrops;

  return (
    <div className="bg-surface border border-divider rounded-2xl p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className="px-2 py-0.5 rounded-full bg-warm-coral/15 text-warm-coral text-xs font-semibold">
          Q{q.original_question_number}
        </span>
        {q.question_type === "Student Produced Response" && (
          <span className="text-soft-mute text-xs">SPR</span>
        )}
        {mine && (
          <span
            className={clsx(
              "ml-auto px-2 py-0.5 rounded-full text-xs font-bold",
              mine.isCorrect
                ? "bg-status-success/15 text-status-success"
                : "bg-status-error/15 text-status-error",
            )}
          >
            {mine.isCorrect ? "You got it right" : "You got it wrong"}
          </span>
        )}
      </div>

      <MathMarkdown className="prose prose-sm max-w-none text-charcoal leading-relaxed [&_p]:my-1.5">
        {q.question_text}
      </MathMarkdown>

      {/* Figures: recovered crops first, else the source PDF page. */}
      {hasCrops && (
        <div className="flex flex-wrap gap-3">
          {q.image_urls!.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={`/api/blob-image?u=${encodeURIComponent(url)}`}
              alt={q.image_alts?.[i] ?? "Question figure"}
              className="max-w-full md:max-w-lg rounded-xl border border-divider bg-white"
            />
          ))}
        </div>
      )}
      {needsFigureFallback && (
        <iframe
          src={`/api/modules/${q.module_id}/page/${q.page_number ?? 1}`}
          className="w-full h-[420px] rounded-xl border border-divider bg-white"
          title={`Question figure (PDF page ${q.page_number ?? 1})`}
        />
      )}

      {choices.length > 0 && (
        <div className="space-y-1.5">
          {choices.map((c) => {
            const isCorrect = c.label === q.correct_answer;
            const isMine = mine?.answer === c.label;
            const mineWrong = isMine && !isCorrect;
            return (
              <div
                key={c.label}
                className={clsx(
                  "flex items-start gap-2.5 p-2.5 rounded-lg text-sm",
                  isCorrect
                    ? "bg-status-success/10 border border-status-success/30 text-charcoal"
                    : mineWrong
                    ? "bg-status-error/10 border border-status-error/30 text-charcoal"
                    : "text-mid-gray",
                )}
              >
                <span className="font-semibold shrink-0">{c.label}.</span>
                <MathMarkdown className="prose prose-sm max-w-none text-inherit [&_p]:my-0">
                  {c.text}
                </MathMarkdown>
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  {isMine && (
                    <span className="text-mid-gray text-xs font-medium">Your answer</span>
                  )}
                  {isCorrect && (
                    <span className="text-status-success text-xs font-bold">Correct</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {q.question_type === "Student Produced Response" && (
        <div className="text-xs text-soft-mute space-y-0.5">
          {mine && (
            <div>
              Your answer:{" "}
              <span
                className={clsx(
                  "font-semibold",
                  mine.isCorrect ? "text-status-success" : "text-status-error",
                )}
              >
                {mine.answer && mine.answer.trim() !== "" ? mine.answer : "(blank)"}
              </span>
            </div>
          )}
          <div>
            Correct answer:{" "}
            <span className="text-status-success font-semibold">
              {q.correct_answer ?? "—"}
            </span>
          </div>
        </div>
      )}

      {showExplanation && q.explanation && (
        <div className="rounded-lg border border-warm-coral/15 bg-warm-coral/5 p-3">
          <div className="text-warm-coral text-xs font-medium mb-1">Explanation</div>
          <MathMarkdown className="prose prose-sm max-w-none text-mid-gray [&_p]:my-1 [&_p]:leading-relaxed">
            {q.explanation}
          </MathMarkdown>
        </div>
      )}

      {/* Teacher review: who missed this question. */}
      {wrongStudents && wrongStudents.length > 0 && (
        <details className="rounded-lg border border-status-error/20 bg-status-error/5 p-3">
          <summary className="text-status-error text-xs font-medium cursor-pointer">
            {wrongStudents.length} student{wrongStudents.length === 1 ? "" : "s"} got this wrong
          </summary>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {wrongStudents.map((name) => (
              <span key={name} className="px-2 py-0.5 rounded-full bg-status-error/10 text-status-error text-xs">
                {name}
              </span>
            ))}
          </div>
        </details>
      )}
      {wrongStudents && wrongStudents.length === 0 && (
        <div className="text-status-success text-xs font-medium">Everyone got this right</div>
      )}
    </div>
  );
}
