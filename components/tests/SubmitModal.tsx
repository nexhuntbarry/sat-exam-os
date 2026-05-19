"use client";

import { CheckCircle, Flag, X } from "lucide-react";
import { clsx } from "clsx";

interface SubmitModalProps {
  totalQuestions: number;
  answeredCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Per-question status for the Bluebook-style review grid. When the
   *  fields below are supplied, the component renders as a full-screen
   *  review page; otherwise it falls back to the legacy compact modal. */
  questionIds?: string[];
  answers?: Record<string, string>;
  flagged?: Set<string>;
  onJumpTo?: (index: number) => void;
}

export default function SubmitModal({
  totalQuestions,
  answeredCount,
  isSubmitting,
  onConfirm,
  onCancel,
  questionIds,
  answers,
  flagged,
  onJumpTo,
}: SubmitModalProps) {
  const unanswered = totalQuestions - answeredCount;
  const flaggedCount = flagged?.size ?? 0;
  const reviewMode = Boolean(questionIds && answers && flagged && onJumpTo);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div
        className={clsx(
          "relative bg-cream border border-divider rounded-2xl shadow-2xl w-full overflow-hidden flex flex-col",
          reviewMode
            ? "max-w-3xl max-h-[90vh]"
            : "max-w-md",
        )}
      >
        <div className="flex items-center justify-between border-b border-divider px-5 py-4">
          <div>
            <h2 className="text-charcoal font-semibold text-lg">
              {reviewMode ? "Check Your Work" : "Submit Test?"}
            </h2>
            <p className="text-soft-mute text-sm">
              {reviewMode
                ? "Review every question before you submit. Click a number to jump back."
                : "This action cannot be undone."}
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-soft-mute hover:text-charcoal transition-colors"
            disabled={isSubmitting}
            aria-label="Close review"
          >
            <X size={18} />
          </button>
        </div>

        {reviewMode ? (
          <>
            <div className="px-5 py-3 border-b border-divider grid grid-cols-3 gap-3 text-sm">
              <Stat label="Answered" value={`${answeredCount} / ${totalQuestions}`} color="amber" />
              <Stat label="Unanswered" value={String(unanswered)} color={unanswered > 0 ? "warning" : "muted"} />
              <Stat label="Marked" value={String(flaggedCount)} color={flaggedCount > 0 ? "coral" : "muted"} />
            </div>

            <div className="flex-1 overflow-auto px-5 py-5">
              <div className="grid grid-cols-6 sm:grid-cols-8 gap-2">
                {Array.from({ length: totalQuestions }, (_, i) => {
                  const qId = questionIds![i];
                  const isAnswered = qId && (answers?.[qId] ?? "").trim() !== "";
                  const isFlagged = qId ? flagged?.has(qId) : false;
                  return (
                    <button
                      key={i}
                      onClick={() => onJumpTo!(i)}
                      className={clsx(
                        "relative aspect-square rounded-lg text-sm font-bold transition-all border",
                        isAnswered
                          ? "bg-warm-amber/20 text-warm-amber border-warm-amber/40 hover:bg-warm-amber/30"
                          : "bg-surface text-mid-gray border-divider hover:border-charcoal/40 hover:text-charcoal",
                      )}
                      title={`Question ${i + 1}${isAnswered ? " — answered" : " — unanswered"}${isFlagged ? " (marked)" : ""}`}
                    >
                      {i + 1}
                      {isFlagged && (
                        <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-status-warning rounded-full flex items-center justify-center">
                          <Flag size={7} className="text-white" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <Legend />
            </div>

            <div className="border-t border-divider px-5 py-4 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
              <p
                className={clsx(
                  "text-sm",
                  unanswered > 0 ? "text-status-warning" : "text-warm-amber",
                )}
              >
                {unanswered > 0
                  ? `You have ${unanswered} unanswered ${unanswered === 1 ? "question" : "questions"}. Unanswered = marked incorrect.`
                  : "All questions answered — nice."}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={onCancel}
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-full border border-divider text-mid-gray hover:text-charcoal text-sm font-medium disabled:opacity-50"
                >
                  Keep Reviewing
                </button>
                <button
                  onClick={onConfirm}
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-full bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                >
                  {isSubmitting ? (
                    "Submitting..."
                  ) : (
                    <>
                      <CheckCircle size={15} /> Submit Test
                    </>
                  )}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="px-5 py-5 space-y-4">
            <div className="bg-surface border border-divider rounded-xl p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-mid-gray">Answered</span>
                <span className="text-warm-amber font-medium">{answeredCount} / {totalQuestions}</span>
              </div>
              {unanswered > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-mid-gray">Unanswered</span>
                  <span className="text-status-warning font-medium">{unanswered} questions</span>
                </div>
              )}
            </div>
            {unanswered > 0 && (
              <p className="text-status-warning text-sm">
                You have {unanswered} unanswered {unanswered === 1 ? "question" : "questions"}. Unanswered questions will be marked incorrect.
              </p>
            )}
            <div className="flex gap-3 pt-2">
              <button
                onClick={onCancel}
                disabled={isSubmitting}
                className="flex-1 px-4 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm font-medium disabled:opacity-50"
              >
                Keep Reviewing
              </button>
              <button
                onClick={onConfirm}
                disabled={isSubmitting}
                className="flex-1 px-4 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? "Submitting..." : "Submit Test"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: "amber" | "warning" | "coral" | "muted";
}) {
  const tone: Record<typeof color, string> = {
    amber: "text-warm-amber",
    warning: "text-status-warning",
    coral: "text-warm-coral",
    muted: "text-mid-gray",
  };
  return (
    <div className="flex flex-col">
      <span className="text-soft-mute text-xs uppercase tracking-wider">{label}</span>
      <span className={clsx("font-bold text-lg", tone[color])}>{value}</span>
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-4 flex flex-wrap gap-3 text-xs text-soft-mute">
      <span className="inline-flex items-center gap-1.5">
        <span className="w-3 h-3 rounded bg-warm-amber/30 border border-warm-amber/40" />
        Answered
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="w-3 h-3 rounded bg-surface border border-divider" />
        Unanswered
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="w-3 h-3 rounded bg-status-warning/30 border border-status-warning/40 inline-flex items-center justify-center">
          <Flag size={6} className="text-status-warning" />
        </span>
        Marked for Review
      </span>
    </div>
  );
}
