"use client";

import { ExternalLink } from "lucide-react";
import { clsx } from "clsx";

interface Choice {
  label: string;
  text: string;
}

interface Question {
  id: string;
  original_question_number: number;
  question_text: string;
  choices: Choice[];
  question_type: "Multiple Choice" | "Student Produced Response";
  has_image: boolean;
  has_table: boolean;
  source_pdf_url?: string | null;
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
        <span className="px-3 py-1 rounded-full bg-electric-blue/15 text-electric-blue text-xs font-semibold">
          Question {questionIndex + 1} of {totalQuestions}
        </span>
        {question.has_image || question.has_table ? (
          <span className="px-2 py-1 rounded-full bg-amber/15 text-amber text-xs font-medium flex items-center gap-1">
            {question.has_image ? "Has Image" : "Has Table"}
          </span>
        ) : null}
      </div>

      {/* Image/table notice */}
      {(question.has_image || question.has_table) && (
        <div className="p-3 rounded-xl bg-amber/10 border border-amber/20 text-amber text-sm flex items-start gap-2">
          <span className="shrink-0 mt-0.5">⚠</span>
          <span>
            This question references {question.has_image ? "an image" : "a table"} — see source PDF.
            {question.source_pdf_url && (
              <a
                href={question.source_pdf_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 inline-flex items-center gap-1 underline hover:no-underline"
              >
                Open PDF <ExternalLink size={12} />
              </a>
            )}
          </span>
        </div>
      )}

      {/* Question text */}
      <div className="text-white text-base leading-relaxed whitespace-pre-wrap">
        {question.question_text}
      </div>

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
                    ? "border-electric-blue bg-electric-blue/10 text-white"
                    : "border-white/10 bg-white/3 text-soft-gray/80 hover:border-white/20 hover:bg-white/5 hover:text-white"
                )}
              >
                <span
                  className={clsx(
                    "shrink-0 w-7 h-7 rounded-full border flex items-center justify-center text-xs font-bold transition-colors",
                    isSelected
                      ? "border-electric-blue bg-electric-blue text-white"
                      : "border-white/20 text-soft-gray/60"
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
          <label className="text-soft-gray/50 text-sm">Your Answer</label>
          <input
            type="text"
            value={selectedAnswer}
            onChange={(e) => onAnswer(e.target.value)}
            placeholder="Enter your answer (e.g. 3, 1/2, 0.5)"
            className="w-full max-w-xs px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-soft-gray/30 focus:outline-none focus:border-electric-blue/60 focus:bg-white/8 transition-colors"
          />
          <p className="text-soft-gray/40 text-xs">
            For fractions, you may enter as decimal (0.5) or fraction (1/2). Both are accepted.
          </p>
        </div>
      )}
    </div>
  );
}
