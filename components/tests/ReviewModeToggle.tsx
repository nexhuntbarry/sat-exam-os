"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { clsx } from "clsx";

interface Props {
  testId: string;
  initialUnlocked: boolean;
}

// Toggle that flips tests.review_unlocked. When ON, every assigned
// student can open the answer-key review for this test, regardless of
// whether they took it. Used by teachers in class to walk through
// questions live; flip back off after the lesson.
export default function ReviewModeToggle({ testId, initialUnlocked }: Props) {
  const router = useRouter();
  const [unlocked, setUnlocked] = useState(initialUnlocked);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function flip() {
    const next = !unlocked;
    setBusy(true);
    try {
      const res = await fetch(`/api/teacher/tests/${testId}/review-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unlocked: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error ?? "Failed to update");
        return;
      }
      setUnlocked(next);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={clsx(
        "flex items-center justify-between gap-3 rounded-2xl border px-4 py-3",
        unlocked
          ? "border-warm-amber/30 bg-warm-amber/10"
          : "border-divider bg-surface",
      )}
    >
      <div className="flex items-start gap-3">
        {unlocked ? (
          <Eye size={18} className="text-warm-amber mt-0.5 shrink-0" />
        ) : (
          <EyeOff size={18} className="text-soft-mute mt-0.5 shrink-0" />
        )}
        <div>
          <div className="text-charcoal font-semibold text-sm">
            Class review {unlocked ? "unlocked" : "locked"}
          </div>
          <p className="text-soft-mute text-xs leading-relaxed mt-0.5">
            {unlocked
              ? "Students assigned to this test can now see all questions, correct answers, explanations, and their own right/wrong answers. Use during in-class walkthroughs, then lock again to hide it all."
              : "Students only see results for tests they themselves submitted. Flip on to open the full answer key + their own answers for class review."}
          </p>
          <p className="text-soft-mute text-[11px] leading-relaxed mt-1.5 border-t border-divider/60 pt-1.5">
            Note: locking here hides the review page. If the test&rsquo;s{" "}
            <span className="font-medium text-mid-gray">&ldquo;Show answers after submission&rdquo;</span>{" "}
            option is on, students can still see their answers on their own results page
            independently of this lock. For &ldquo;only during review, then hidden,&rdquo; keep that option off.
          </p>
        </div>
      </div>
      <button
        onClick={flip}
        disabled={busy}
        className={clsx(
          "shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50",
          unlocked
            ? "bg-status-error/15 text-status-error hover:bg-status-error/25"
            : "bg-warm-coral text-white hover:bg-warm-coral-dark",
        )}
      >
        {busy ? "…" : unlocked ? "Lock again" : "Unlock for class"}
      </button>
    </div>
  );
}
