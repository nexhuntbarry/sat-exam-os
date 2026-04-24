"use client";

import { Flag } from "lucide-react";
import { clsx } from "clsx";

interface QuestionNavigatorProps {
  totalQuestions: number;
  currentIndex: number;
  answers: Record<string, string>;
  questionIds: string[];
  flagged: Set<string>;
  onNavigate: (index: number) => void;
  onToggleFlag: (questionId: string) => void;
}

export default function QuestionNavigator({
  totalQuestions,
  currentIndex,
  answers,
  questionIds,
  flagged,
  onNavigate,
  onToggleFlag,
}: QuestionNavigatorProps) {
  return (
    <div className="bg-deep-navy border-t border-white/8 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-3">
          <span className="text-soft-gray/50 text-xs font-medium uppercase tracking-wider">
            Question Navigator
          </span>
          <div className="flex items-center gap-4 text-xs text-soft-gray/40">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-lime-green/60 inline-block" /> Answered
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-white/10 inline-block" /> Unanswered
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-amber/60 inline-block" /> Flagged
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: totalQuestions }, (_, i) => {
            const qId = questionIds[i];
            const isAnswered = qId && answers[qId] && answers[qId].trim() !== "";
            const isFlagged = qId && flagged.has(qId);
            const isCurrent = i === currentIndex;

            return (
              <div key={i} className="relative">
                <button
                  onClick={() => onNavigate(i)}
                  className={clsx(
                    "w-9 h-9 rounded-lg text-xs font-semibold transition-all",
                    isCurrent
                      ? "ring-2 ring-electric-blue bg-electric-blue/20 text-electric-blue"
                      : isFlagged
                      ? "bg-amber/20 text-amber hover:bg-amber/30"
                      : isAnswered
                      ? "bg-lime-green/20 text-lime-green hover:bg-lime-green/30"
                      : "bg-white/8 text-soft-gray/50 hover:bg-white/12 hover:text-soft-gray"
                  )}
                >
                  {i + 1}
                </button>
                {isFlagged && (
                  <span className="absolute -top-1 -right-1 w-3 h-3 bg-amber rounded-full flex items-center justify-center">
                    <Flag size={6} className="text-deep-navy" />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
