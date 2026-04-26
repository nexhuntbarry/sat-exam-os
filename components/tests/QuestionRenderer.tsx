"use client";

import { ExternalLink } from "lucide-react";
import { clsx } from "clsx";

interface Choice {
  label: string;
  text: string;
}

interface Question {
  id: string;
  module_id: string;
  original_question_number: number;
  question_text: string;
  choices: Choice[];
  question_type: "Multiple Choice" | "Student Produced Response";
  has_image: boolean;
  has_table: boolean;
  source_pdf_url?: string | null;
  page_number?: number | null;
  image_urls?: string[] | null;
  image_alts?: string[] | null;
}

interface QuestionRendererProps {
  question: Question;
  selectedAnswer: string;
  onAnswer: (answer: string) => void;
  questionIndex: number;
  totalQuestions: number;
}

export default function QuestionRenderer({
  question,
  selectedAnswer,
  onAnswer,
  questionIndex,
  totalQuestions,
}: QuestionRendererProps) {
  const isMultipleChoice = question.question_type === "Multiple Choice";

  return (
    <div className="space-y-6">
      {/* Question number */}
      <div className="flex items-center gap-3">
        <span className="px-3 py-1 rounded-full bg-warm-coral/15 text-warm-coral text-xs font-semibold">
          Question {questionIndex + 1} of {totalQuestions}
        </span>
        {question.has_image || question.has_table ? (
          <span className="px-2 py-1 rounded-full bg-status-warning/15 text-status-warning text-xs font-medium flex items-center gap-1">
            {question.has_image ? "Has Image" : "Has Table"}
          </span>
        ) : null}
      </div>

      {/* Question text */}
      <div className="text-charcoal text-base leading-relaxed whitespace-pre-wrap">
        {question.question_text}
      </div>

      {/* Inline PDF page — primary path for any question flagged with a
          visual element. The serverless image cropper is too fragile, so we
          render the original PDF page directly via iframe + #page=N. */}
      {(question.has_image || question.has_table) && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-soft-mute text-xs uppercase tracking-wide font-medium">
              Source figure · Page {question.page_number ?? 1}
            </p>
            <a
              href={`/api/modules/${question.module_id}/pdf#page=${question.page_number ?? 1}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-warm-coral hover:underline"
            >
              Open in new tab <ExternalLink size={12} />
            </a>
          </div>
          <iframe
            src={`/api/modules/${question.module_id}/pdf#page=${question.page_number ?? 1}`}
            className="w-full h-[480px] rounded-xl border border-divider bg-white"
            title={`Question figure (PDF page ${question.page_number ?? 1})`}
          />
        </div>
      )}

      {/* Optional fallback — extracted crops still rendered when present, as
          an enhancement to the inline PDF view. */}
      {question.image_urls && question.image_urls.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {question.image_urls.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={url}
              src={`/api/blob-image?u=${encodeURIComponent(url)}`}
              alt={question.image_alts?.[i] ?? "Question image"}
              className="max-w-full md:max-w-lg rounded-xl border border-divider bg-white"
            />
          ))}
        </div>
      )}

      {/* Answer area */}
      {isMultipleChoice ? (
        <div className="space-y-3">
          {(question.choices ?? []).map((choice) => {
            const isSelected = selectedAnswer === choice.label;
            return (
              <button
                key={choice.label}
                onClick={() => onAnswer(choice.label)}
                className={clsx(
                  "w-full flex items-start gap-3 p-4 rounded-xl border text-left transition-all",
                  isSelected
                    ? "border-warm-coral bg-warm-coral/10 text-charcoal"
                    : "border-divider bg-surface text-charcoal hover:border-divider hover:bg-light-bg hover:text-charcoal"
                )}
              >
                <span
                  className={clsx(
                    "shrink-0 w-7 h-7 rounded-full border flex items-center justify-center text-xs font-bold transition-colors",
                    isSelected
                      ? "border-warm-coral bg-warm-coral text-white"
                      : "border-divider text-mid-gray"
                  )}
                >
                  {choice.label}
                </span>
                <span className="flex-1 leading-relaxed pt-0.5">{choice.text}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-soft-mute text-sm">Your Answer</label>
          <input
            type="text"
            value={selectedAnswer}
            onChange={(e) => onAnswer(e.target.value)}
            placeholder="Enter your answer (e.g. 3, 1/2, 0.5)"
            className="w-full max-w-xs px-4 py-3 rounded-xl bg-surface border border-divider text-charcoal placeholder-soft-mute focus:outline-none focus:border-warm-coral/60 focus:bg-surface transition-colors"
          />
          <p className="text-soft-mute text-xs">
            For fractions, you may enter as decimal (0.5) or fraction (1/2). Both are accepted.
          </p>
        </div>
      )}
    </div>
  );
}
