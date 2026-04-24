"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { ChevronDown, ChevronRight, Check, X, Flag, BookOpen } from "lucide-react";

export interface AnswerDetail {
  questionId: string;
  questionNumber: number;
  questionText: string;
  choices: Array<{ letter: string; text: string }>;
  studentAnswer: string | null;
  correctAnswer: string | null;
  isCorrect: boolean | null;
  timeSpentSeconds: number | null;
  wasFlagged: boolean;
  explanation: string | null;
  domain: string | null;
  skill: string | null;
  difficulty: string | null;
  classReview: boolean;
  privateNote: string;
}

interface SubmissionDetailPanelProps {
  answers: AnswerDetail[];
  testId: string;
  onToggleClassReview: (questionId: string, current: boolean) => void;
  onSaveNote: (questionId: string, note: string) => void;
}

export function SubmissionDetailPanel({
  answers,
  testId,
  onToggleClassReview,
  onSaveNote,
}: SubmissionDetailPanelProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>(
    Object.fromEntries(answers.map((a) => [a.questionId, a.privateNote]))
  );

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function fmtTime(s: number | null) {
    if (!s) return "—";
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  return (
    <div className="bg-white/3 border border-white/8 rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-white/8 flex items-center justify-between">
        <h2 className="text-white font-semibold">Per-Question Review</h2>
        <div className="text-soft-gray/40 text-xs">
          {answers.filter((a) => a.isCorrect).length} / {answers.length} correct
        </div>
      </div>
      <div>
        {answers.map((a) => (
          <div key={a.questionId} className="border-b border-white/5 last:border-0">
            {/* Row */}
            <div
              className="px-5 py-3 flex items-center gap-3 cursor-pointer hover:bg-white/2 transition-colors"
              onClick={() => toggle(a.questionId)}
            >
              <div className="text-soft-gray/30 flex-shrink-0">
                {expanded[a.questionId] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </div>

              {/* Q# */}
              <div className="flex-shrink-0 w-8 text-soft-gray/40 text-sm font-mono">
                Q{a.questionNumber}
              </div>

              {/* Correct/wrong icon */}
              <div className="flex-shrink-0">
                {a.isCorrect === true ? (
                  <Check size={16} className="text-lime-green" />
                ) : a.isCorrect === false ? (
                  <X size={16} className="text-rose" />
                ) : (
                  <div className="w-4 h-4 rounded-full bg-white/10" />
                )}
              </div>

              {/* Question preview */}
              <div className="flex-1 min-w-0">
                <p className="text-soft-gray/70 text-sm truncate">
                  {a.questionText.slice(0, 70)}{a.questionText.length > 70 ? "…" : ""}
                </p>
                {a.domain && (
                  <span className="text-soft-gray/30 text-xs">{a.domain}</span>
                )}
              </div>

              {/* Student answer */}
              <div className="flex-shrink-0 text-sm">
                <span className={clsx(
                  "px-2 py-0.5 rounded font-mono font-bold",
                  a.isCorrect ? "bg-lime-green/15 text-lime-green" : "bg-rose/15 text-rose"
                )}>
                  {a.studentAnswer ?? "—"}
                </span>
              </div>

              {/* Time */}
              <div className="flex-shrink-0 text-soft-gray/40 text-xs hidden sm:block w-16 text-right">
                {fmtTime(a.timeSpentSeconds)}
              </div>

              {/* Flags */}
              {a.wasFlagged && (
                <Flag size={12} className="text-amber flex-shrink-0" />
              )}
            </div>

            {/* Expanded */}
            {expanded[a.questionId] && (
              <div className="px-12 pb-5 space-y-4">
                {/* Full question */}
                <div className="text-soft-gray/80 text-sm leading-relaxed bg-white/3 rounded-lg p-4">
                  {a.questionText}
                </div>

                {/* Choices */}
                {a.choices.length > 0 && (
                  <div className="space-y-2">
                    {a.choices.map((ch) => {
                      const isCorrect = ch.letter === a.correctAnswer;
                      const isStudentAnswer = ch.letter === a.studentAnswer;
                      return (
                        <div
                          key={ch.letter}
                          className={clsx(
                            "flex items-start gap-3 px-3 py-2 rounded-lg text-sm",
                            isCorrect
                              ? "bg-lime-green/10 border border-lime-green/20"
                              : isStudentAnswer
                              ? "bg-rose/10 border border-rose/20"
                              : "bg-white/3 border border-transparent"
                          )}
                        >
                          <span className={clsx(
                            "flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold",
                            isCorrect ? "bg-lime-green text-deep-navy" :
                            isStudentAnswer ? "bg-rose text-white" : "bg-white/10 text-soft-gray/60"
                          )}>
                            {ch.letter}
                          </span>
                          <span className={clsx(
                            isCorrect ? "text-lime-green" :
                            isStudentAnswer ? "text-rose" : "text-soft-gray/60"
                          )}>
                            {ch.text}
                          </span>
                          {isCorrect && (
                            <Check size={14} className="text-lime-green ml-auto flex-shrink-0 mt-0.5" />
                          )}
                          {isStudentAnswer && !isCorrect && (
                            <X size={14} className="text-rose ml-auto flex-shrink-0 mt-0.5" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* SPR: student answer / correct answer */}
                {a.choices.length === 0 && (
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="bg-white/3 rounded-lg p-3">
                      <div className="text-soft-gray/40 text-xs mb-1">Your answer</div>
                      <div className={clsx("font-mono font-bold", a.isCorrect ? "text-lime-green" : "text-rose")}>
                        {a.studentAnswer ?? "—"}
                      </div>
                    </div>
                    <div className="bg-white/3 rounded-lg p-3">
                      <div className="text-soft-gray/40 text-xs mb-1">Correct answer</div>
                      <div className="text-lime-green font-mono font-bold">{a.correctAnswer ?? "—"}</div>
                    </div>
                  </div>
                )}

                {/* Explanation */}
                {a.explanation && (
                  <div className="bg-lime-green/5 border border-lime-green/10 rounded-lg p-3 text-sm text-soft-gray/70">
                    <div className="text-lime-green font-semibold text-xs mb-1">Explanation</div>
                    {a.explanation}
                  </div>
                )}

                {/* Teacher tools */}
                <div className="flex flex-col gap-3 pt-2 border-t border-white/5">
                  {/* Class review toggle */}
                  <button
                    onClick={() => onToggleClassReview(a.questionId, a.classReview)}
                    className={clsx(
                      "self-start flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                      a.classReview
                        ? "bg-electric-blue/20 text-electric-blue border border-electric-blue/30"
                        : "bg-white/5 text-soft-gray/50 border border-white/10 hover:border-electric-blue/20 hover:text-electric-blue"
                    )}
                  >
                    <BookOpen size={14} />
                    {a.classReview ? "Marked for class review" : "Mark for class review"}
                  </button>

                  {/* Private note */}
                  <div>
                    <label className="text-soft-gray/40 text-xs mb-1 block">Private note</label>
                    <textarea
                      rows={2}
                      value={notes[a.questionId] ?? ""}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [a.questionId]: e.target.value }))}
                      onBlur={() => onSaveNote(a.questionId, notes[a.questionId] ?? "")}
                      placeholder="Add a private note..."
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-soft-gray/80 placeholder:text-soft-gray/20 focus:outline-none focus:border-electric-blue/40 resize-none"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
