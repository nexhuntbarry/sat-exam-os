"use client";

import { AlertTriangle, CheckCircle, X } from "lucide-react";

interface SubmitModalProps {
  totalQuestions: number;
  answeredCount: number;
  isSubmitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function SubmitModal({
  totalQuestions,
  answeredCount,
  isSubmitting,
  onConfirm,
  onCancel,
}: SubmitModalProps) {
  const unanswered = totalQuestions - answeredCount;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-surface border border-divider rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 text-soft-mute hover:text-charcoal transition-colors"
        >
          <X size={18} />
        </button>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {unanswered > 0 ? (
              <div className="w-10 h-10 rounded-full bg-status-warning/15 flex items-center justify-center shrink-0">
                <AlertTriangle size={20} className="text-status-warning" />
              </div>
            ) : (
              <div className="w-10 h-10 rounded-full bg-warm-amber/15 flex items-center justify-center shrink-0">
                <CheckCircle size={20} className="text-warm-amber" />
              </div>
            )}
            <div>
              <h2 className="text-charcoal font-semibold text-lg">Submit Test?</h2>
              <p className="text-soft-mute text-sm">This action cannot be undone.</p>
            </div>
          </div>

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
              className="flex-1 px-4 py-2.5 rounded-xl border border-divider text-mid-gray hover:text-charcoal hover:border-divider transition-colors text-sm font-medium disabled:opacity-50"
            >
              Keep Reviewing
            </button>
            <button
              onClick={onConfirm}
              disabled={isSubmitting}
              className="flex-1 px-4 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Submitting..." : "Submit Test"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
