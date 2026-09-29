"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";

interface Props {
  testId: string;
  initialShowAnswers: boolean;
  initialShowExplanations: boolean;
}

// Live toggle for post-submission answer/explanation visibility on an
// already-created test — the same two settings the create-test wizard
// offers, but flippable after the fact. Separate from the class-review
// unlock (that one opens a walkthrough; this one governs the student's own
// results page).
export default function AnswerVisibilityToggle({
  testId,
  initialShowAnswers,
  initialShowExplanations,
}: Props) {
  const router = useRouter();
  const [showAnswers, setShowAnswers] = useState(initialShowAnswers);
  const [showExplanations, setShowExplanations] = useState(initialShowExplanations);
  const [busy, setBusy] = useState(false);

  async function patch(next: { showAnswers?: boolean; showExplanations?: boolean }) {
    setBusy(true);
    try {
      const res = await fetch(`/api/teacher/tests/${testId}/answer-visibility`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error ?? "Failed to update");
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function toggleAnswers() {
    const next = !showAnswers;
    setShowAnswers(next);
    if (!(await patch({ showAnswers: next }))) setShowAnswers(!next);
  }
  async function toggleExplanations() {
    const next = !showExplanations;
    setShowExplanations(next);
    if (!(await patch({ showExplanations: next }))) setShowExplanations(!next);
  }

  const Switch = ({ on }: { on: boolean }) => (
    <div
      className={clsx(
        "w-10 h-6 rounded-full transition-colors relative shrink-0",
        on ? "bg-warm-coral" : "bg-light-bg",
        busy && "opacity-60",
      )}
    >
      <span
        className={clsx(
          "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
          on ? "translate-x-5" : "translate-x-1",
        )}
      />
    </div>
  );

  return (
    <div className="rounded-2xl border border-divider bg-surface p-4 space-y-3">
      <div className="text-charcoal font-semibold text-sm">Answer visibility (results page)</div>

      <button
        onClick={toggleAnswers}
        disabled={busy}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div>
          <div className="text-charcoal text-sm font-medium">Show answers after submission</div>
          <div className="text-soft-mute text-xs">Students see correct answers on their own results page anytime.</div>
        </div>
        <Switch on={showAnswers} />
      </button>

      {showAnswers && (
        <button
          onClick={toggleExplanations}
          disabled={busy}
          className="w-full flex items-center justify-between gap-3 text-left pl-4 border-l-2 border-divider"
        >
          <div>
            <div className="text-charcoal text-sm font-medium">Show explanations</div>
            <div className="text-soft-mute text-xs">Include the worked explanation for each question.</div>
          </div>
          <Switch on={showExplanations} />
        </button>
      )}

      <p className="text-soft-mute text-[11px] leading-relaxed border-t border-divider/60 pt-2">
        For &ldquo;only during class review, then hidden,&rdquo; keep Show answers off here and use
        the Class review unlock instead.
      </p>
    </div>
  );
}
