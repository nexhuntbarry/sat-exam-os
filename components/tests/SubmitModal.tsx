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
      <div className="relative bg-deep-navy border border-white/12 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 text-soft-gray/40 hover:text-soft-gray transition-colors"
        >
          <X size={18} />
        </button>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {unanswered > 0 ? (
              <div className="w-10 h-10 rounded-full bg-amber/15 flex items-center justify-center shrink-0">
                <AlertTriangle size={20} className="text-amber" />
              </div>
            ) : (
              <div className="w-10 h-10 rounded-full bg-lime-green/15 flex items-center justify-center shrink-0">
                <CheckCircle size={20} className="text-lime-green" />
              </div>
            )}
            <div>
              <h2 className="text-white font-semibold text-lg">Submit Test?</h2>
              <p className="text-soft-gray/50 text-sm">This action cannot be undone.</p>
            </div>
          </div>

          <div className="bg-white/3 border border-white/8 rounded-xl p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-soft-gray/60">Answered</span>
              <span className="text-lime-green font-medium">{answeredCount} / {totalQuestions}</span>
            </div>
            {unanswered > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-soft-gray/60">Unanswered</span>
                <span className="text-amber font-medium">{unanswered} questions</span>
              </div>
            )}
          </div>

          {unanswered > 0 && (
            <p className="text-amber/80 text-sm">
              You have {unanswered} unanswered {unanswered === 1 ? "question" : "questions"}. Unanswered questions will be marked incorrect.
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={onCancel}
              disabled={isSubmitting}
              className="flex-1 px-4 py-2.5 rounded-xl border border-white/10 text-soft-gray/70 hover:text-soft-gray hover:border-white/20 transition-colors text-sm font-medium disabled:opacity-50"
            >
              Keep Reviewing
            </button>
            <button
              onClick={onConfirm}
              disabled={isSubmitting}
              className="flex-1 px-4 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Submitting..." : "Submit Test"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
