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
    <div className="bg-cream border-t border-divider p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-3">
          <span className="text-soft-mute text-xs font-medium uppercase tracking-wider">
            Question Navigator
          </span>
          <div className="flex items-center gap-4 text-xs text-soft-mute">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-warm-amber/60 inline-block" /> Answered
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-light-bg inline-block" /> Unanswered
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-status-warning/60 inline-block" /> Flagged
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
                      ? "ring-2 ring-warm-coral bg-warm-coral/20 text-warm-coral"
                      : isFlagged
                      ? "bg-status-warning/15 text-status-warning hover:bg-status-warning/30"
                      : isAnswered
                      ? "bg-warm-amber/20 text-warm-amber hover:bg-warm-amber/25"
                      : "bg-surface text-soft-mute hover:bg-light-bg hover:text-charcoal"
                  )}
                >
                  {i + 1}
                </button>
                {isFlagged && (
                  <span className="absolute -top-1 -right-1 w-3 h-3 bg-status-warning rounded-full flex items-center justify-center">
                    <Flag size={6} className="text-charcoal" />
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
