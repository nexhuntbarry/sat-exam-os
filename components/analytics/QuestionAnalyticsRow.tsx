"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { ChevronDown, ChevronRight, BookOpen, Flag } from "lucide-react";

export interface QuestionAnalyticsData {
  questionId: string;
  questionNumber: number;
  questionText: string;
  correctAnswer: string;
  difficulty: string | null;
  domain: string | null;
  skill: string | null;
  explanation: string | null;
  totalSubmissions: number;
  correctCount: number;
  wrongCount: number;
  blankCount: number;
  flaggedCount: number;
  avgTimeSeconds: number | null;
  choiceDistribution: Record<string, number>; // { A: 12, B: 3, C: 0, D: 5, blank: 2 }
  mostSelectedWrong: string | null;
  classReview: boolean;
}

interface QuestionAnalyticsRowProps {
  q: QuestionAnalyticsData;
  onToggleClassReview: (questionId: string, current: boolean) => void;
}

const difficultyColor: Record<string, string> = {
  Easy: "text-warm-amber",
  Medium: "text-status-warning",
  Hard: "text-status-error",
};

const CHOICE_COLORS: Record<string, string> = {
  A: "bg-warm-coral",
  B: "bg-warm-amber",
  C: "bg-status-warning",
  D: "bg-status-success",
  blank: "bg-light-bg/30",
};

export function QuestionAnalyticsRow({ q, onToggleClassReview }: QuestionAnalyticsRowProps) {
  const [expanded, setExpanded] = useState(false);

  const correctRate = q.totalSubmissions > 0
    ? ((q.correctCount / q.totalSubmissions) * 100).toFixed(1)
    : "0";

  const wrongRate = q.totalSubmissions > 0
    ? ((q.wrongCount / q.totalSubmissions) * 100).toFixed(1)
    : "0";

  const choices = ["A", "B", "C", "D", "blank"];
  const total = q.totalSubmissions || 1;

  return (
    <div
      className={clsx(
        "border-b border-divider last:border-0 transition-colors",
        q.classReview && "bg-warm-coral/5"
      )}
    >
      {/* Main row */}
      <div
        className="px-5 py-4 flex items-center gap-4 cursor-pointer hover:bg-light-bg/60 transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex-shrink-0 text-soft-mute w-4">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>

        {/* Q# */}
        <div className="flex-shrink-0 w-8 text-soft-mute text-sm font-mono">
          Q{q.questionNumber}
        </div>

        {/* Question text preview */}
        <div className="flex-1 min-w-0">
          <p className="text-charcoal text-sm truncate">
            {q.questionText.slice(0, 80)}
            {q.questionText.length > 80 ? "…" : ""}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            {q.domain && (
              <span className="text-soft-mute text-xs">{q.domain}</span>
            )}
            {q.difficulty && (
              <span className={clsx("text-xs font-medium", difficultyColor[q.difficulty] ?? "text-soft-mute")}>
                {q.difficulty}
              </span>
            )}
          </div>
        </div>

        {/* Correct rate */}
        <div className="flex-shrink-0 w-20 text-right">
          <span className={clsx(
            "text-sm font-bold",
            Number(correctRate) >= 70 ? "text-warm-amber" :
            Number(correctRate) >= 40 ? "text-status-warning" : "text-status-error"
          )}>
            {correctRate}%
          </span>
          <div className="text-soft-mute text-xs">correct</div>
        </div>

        {/* Stacked bar */}
        <div className="flex-shrink-0 w-36 hidden md:block">
          <div className="flex h-3 rounded overflow-hidden gap-px">
            {choices.map((c) => {
              const count = q.choiceDistribution[c] ?? 0;
              const pct = (count / total) * 100;
              if (pct === 0) return null;
              return (
                <div
                  key={c}
                  className={clsx("transition-all", CHOICE_COLORS[c])}
                  style={{ width: `${pct}%` }}
                  title={`${c}: ${count} (${pct.toFixed(1)}%)`}
                />
              );
            })}
          </div>
          <div className="flex justify-between text-xs text-soft-mute mt-0.5">
            <span>A</span><span>D</span>
          </div>
        </div>

        {/* Flagged */}
        <div className="flex-shrink-0 w-16 text-center hidden sm:flex items-center justify-center gap-1">
          {q.flaggedCount > 0 && (
            <>
              <Flag size={12} className="text-status-warning" />
              <span className="text-status-warning text-xs">{q.flaggedCount}</span>
            </>
          )}
        </div>

        {/* Class review toggle */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleClassReview(q.questionId, q.classReview);
          }}
          className={clsx(
            "flex-shrink-0 px-2 py-1 rounded text-xs font-medium transition-colors",
            q.classReview
              ? "bg-warm-coral/20 text-warm-coral border border-warm-coral/30"
              : "bg-light-bg text-soft-mute border border-divider hover:border-warm-coral/30 hover:text-warm-coral"
          )}
        >
          <BookOpen size={12} className="inline mr-1" />
          {q.classReview ? "Reviewing" : "Review"}
        </button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-12 pb-5 space-y-3">
          <div className="text-mid-gray text-sm leading-relaxed bg-surface rounded-lg p-4">
            {q.questionText}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-soft-mute">Correct Answer</div>
              <div className="text-warm-amber font-bold">{q.correctAnswer}</div>
            </div>
            <div>
              <div className="text-soft-mute">Most-selected wrong</div>
              <div className="text-status-error font-bold">{q.mostSelectedWrong ?? "—"}</div>
            </div>
            <div>
              <div className="text-soft-mute">Avg time</div>
              <div className="text-charcoal">
                {q.avgTimeSeconds != null
                  ? `${Math.floor(q.avgTimeSeconds / 60)}m ${Math.round(q.avgTimeSeconds % 60)}s`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-soft-mute">Left blank</div>
              <div className="text-charcoal">{q.blankCount}</div>
            </div>
          </div>

          {/* Choice distribution detail */}
          <div className="space-y-1.5">
            {choices.map((c) => {
              const count = q.choiceDistribution[c] ?? 0;
              const pct = total > 0 ? (count / total) * 100 : 0;
              const isCorrect = c === q.correctAnswer;
              return (
                <div key={c} className="flex items-center gap-2 text-xs">
                  <span className={clsx(
                    "w-6 h-5 rounded text-center font-bold flex items-center justify-center",
                    isCorrect ? "bg-warm-amber text-charcoal" : "bg-light-bg text-mid-gray"
                  )}>
                    {c === "blank" ? "—" : c}
                  </span>
                  <div className="flex-1 bg-light-bg rounded-full h-2 overflow-hidden">
                    <div
                      className={clsx("h-full rounded-full", isCorrect ? "bg-warm-amber" : "bg-warm-coral/50")}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-soft-mute w-12 text-right">
                    {count} ({pct.toFixed(0)}%)
                  </span>
                </div>
              );
            })}
          </div>

          {q.explanation && (
            <div className="bg-warm-amber/5 border border-warm-amber/10 rounded-lg p-3 text-sm text-mid-gray">
              <div className="text-warm-amber font-semibold text-xs mb-1">Explanation</div>
              {q.explanation}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
