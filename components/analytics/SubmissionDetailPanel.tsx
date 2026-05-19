"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { ChevronDown, ChevronRight, Check, X, Flag, BookOpen } from "lucide-react";
import MathMarkdown from "@/components/MathMarkdown";
import HighlightableBlock, { type Annotation } from "@/components/tests/HighlightableBlock";

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
  /** Student-applied highlights/notes captured during the take. */
  studentAnnotations?: Record<string, Annotation[]> | null;
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

  // The parent's "Print / Save PDF" button fires this event before
  // calling window.print() so every collapsed row renders before the
  // print snapshot. The expanded body is gated by React state (not a
  // <details> element) so a CSS-only print rule wouldn't expose it.
  useEffect(() => {
    function expandAll() {
      setExpanded(Object.fromEntries(answers.map((a) => [a.questionId, true])));
    }
    window.addEventListener("submission-detail-expand-all", expandAll);
    return () => window.removeEventListener("submission-detail-expand-all", expandAll);
  }, [answers]);

  function fmtTime(s: number | null) {
    if (!s) return "—";
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  return (
    <div className="bg-surface border border-divider rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-divider flex items-center justify-between">
        <h2 className="text-charcoal font-semibold">Per-Question Review</h2>
        <div className="text-soft-mute text-xs">
          {answers.filter((a) => a.isCorrect).length} / {answers.length} correct
        </div>
      </div>
      <div>
        {answers.map((a) => (
          <div key={a.questionId} className="border-b border-divider last:border-0">
            {/* Row */}
            <div
              className="px-5 py-3 flex items-center gap-3 cursor-pointer hover:bg-light-bg/60 transition-colors"
              onClick={() => toggle(a.questionId)}
            >
              <div className="text-soft-mute flex-shrink-0">
                {expanded[a.questionId] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </div>

              {/* Q# */}
              <div className="flex-shrink-0 w-8 text-soft-mute text-sm font-mono">
                Q{a.questionNumber}
              </div>

              {/* Correct/wrong icon */}
              <div className="flex-shrink-0">
                {a.isCorrect === true ? (
                  <Check size={16} className="text-status-success" />
                ) : a.isCorrect === false ? (
                  <X size={16} className="text-status-error" />
                ) : (
                  <div className="w-4 h-4 rounded-full bg-light-bg" />
                )}
              </div>

              {/* Question preview — render through MathMarkdown so $...$
                  expressions display as KaTeX instead of raw "$\frac{1}{7}$"
                  text. Tailwind's line-clamp-1 keeps it on one line. */}
              <div className="flex-1 min-w-0">
                <MathMarkdown className="text-mid-gray text-sm line-clamp-1 prose prose-sm max-w-none [&_p]:my-0">
                  {a.questionText}
                </MathMarkdown>
                {a.domain && (
                  <span className="text-soft-mute text-xs">{a.domain}</span>
                )}
              </div>

              {/* Student answer */}
              <div className="flex-shrink-0 text-sm">
                <span className={clsx(
                  "px-2 py-0.5 rounded font-mono font-bold",
                  a.isCorrect ? "bg-status-success/15 text-status-success" : "bg-status-error/15 text-status-error"
                )}>
                  {a.studentAnswer ?? "—"}
                </span>
              </div>

              {/* Time */}
              <div className="flex-shrink-0 text-soft-mute text-xs hidden sm:block w-16 text-right">
                {fmtTime(a.timeSpentSeconds)}
              </div>

              {/* Flags */}
              {a.wasFlagged && (
                <Flag size={12} className="text-status-warning flex-shrink-0" />
              )}
            </div>

            {/* Expanded */}
            {expanded[a.questionId] && (
              <div className="px-12 pb-5 space-y-4">
                {/* Full question with student's highlights overlaid (read-only) */}
                <div className="bg-surface rounded-lg p-4">
                  {(() => {
                    const stemAnnos = a.studentAnnotations?.["stem"] ?? [];
                    const hasAnnos = stemAnnos.length > 0;
                    return (
                      <>
                        <HighlightableBlock
                          anchor="stem"
                          annotations={stemAnnos}
                          enabled={false}
                        >
                          <MathMarkdown className="text-charcoal text-sm leading-relaxed prose prose-sm max-w-none [&_p]:my-2">
                            {a.questionText}
                          </MathMarkdown>
                        </HighlightableBlock>
                        {hasAnnos && (
                          <p className="text-soft-mute text-[11px] mt-2 italic">
                            Student highlighted {stemAnnos.length}{" "}
                            {stemAnnos.length === 1 ? "passage" : "passages"}
                            {stemAnnos.some((x) => x.note) ? " (click yellow to see notes)" : ""}.
                          </p>
                        )}
                      </>
                    );
                  })()}
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
                              ? "bg-status-success/10 border border-status-success/30"
                              : isStudentAnswer
                              ? "bg-status-error/10 border border-status-error/20"
                              : "bg-surface border border-transparent"
                          )}
                        >
                          <span className={clsx(
                            "flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold",
                            isCorrect ? "bg-status-success text-white" :
                            isStudentAnswer ? "bg-status-error text-white" : "bg-light-bg text-mid-gray"
                          )}>
                            {ch.letter}
                          </span>
                          <HighlightableBlock
                            anchor={`choice:${ch.letter}`}
                            annotations={a.studentAnnotations?.[`choice:${ch.letter}`] ?? []}
                            enabled={false}
                          >
                            <MathMarkdown className={clsx(
                              "prose prose-sm max-w-none [&_p]:my-0",
                              isCorrect ? "text-status-success" :
                              isStudentAnswer ? "text-status-error" : "text-mid-gray"
                            )}>
                              {ch.text}
                            </MathMarkdown>
                          </HighlightableBlock>
                          {isCorrect && (
                            <Check size={14} className="text-status-success ml-auto flex-shrink-0 mt-0.5" />
                          )}
                          {isStudentAnswer && !isCorrect && (
                            <X size={14} className="text-status-error ml-auto flex-shrink-0 mt-0.5" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* SPR: student answer / correct answer */}
                {a.choices.length === 0 && (
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="bg-surface rounded-lg p-3">
                      <div className="text-soft-mute text-xs mb-1">Your answer</div>
                      {a.studentAnswer && a.studentAnswer.trim() !== "" ? (
                        <div className={clsx("font-mono font-bold", a.isCorrect ? "text-status-success" : "text-status-error")}>
                          {a.studentAnswer}
                        </div>
                      ) : (
                        <div className="font-mono font-bold text-status-warning italic">Blank</div>
                      )}
                    </div>
                    <div className="bg-surface rounded-lg p-3">
                      <div className="text-soft-mute text-xs mb-1">Correct answer</div>
                      <div className="text-status-success font-mono font-bold">{a.correctAnswer ?? "—"}</div>
                    </div>
                  </div>
                )}

                {/* Explanation */}
                {a.explanation && (
                  <div className="bg-warm-amber/5 border border-warm-amber/10 rounded-lg p-3 text-sm text-mid-gray">
                    <div className="text-warm-amber font-semibold text-xs mb-1">Explanation</div>
                    <MathMarkdown className="prose prose-sm max-w-none text-mid-gray [&_p]:my-1">
                      {a.explanation}
                    </MathMarkdown>
                  </div>
                )}

                {/* Teacher tools */}
                <div className="flex flex-col gap-3 pt-2 border-t border-divider">
                  {/* Class review toggle */}
                  <button
                    onClick={() => onToggleClassReview(a.questionId, a.classReview)}
                    className={clsx(
                      "self-start flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                      a.classReview
                        ? "bg-warm-coral/20 text-warm-coral border border-warm-coral/30"
                        : "bg-light-bg text-soft-mute border border-divider hover:border-warm-coral/20 hover:text-warm-coral"
                    )}
                  >
                    <BookOpen size={14} />
                    {a.classReview ? "Marked for class review" : "Mark for class review"}
                  </button>

                  {/* Private note */}
                  <div>
                    <label className="text-soft-mute text-xs mb-1 block">Private note</label>
                    <textarea
                      rows={2}
                      value={notes[a.questionId] ?? ""}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [a.questionId]: e.target.value }))}
                      onBlur={() => onSaveNote(a.questionId, notes[a.questionId] ?? "")}
                      placeholder="Add a private note..."
                      className="w-full bg-light-bg border border-divider rounded-lg px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/20 focus:outline-none focus:border-warm-coral/40 resize-none"
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
