"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { StudentAnswerMode } from "@/lib/answer-visibility";

interface Props {
  testId: string;
  studentId: string;
  initialMode: StudentAnswerMode;
  initialShowExplanations: boolean;
}

// Per-student answer visibility picker (Follow / Show / Hide + explanations).
// The server enforces it; after saving we refresh so the effective-state
// label rendered next to this control is recomputed server-side.
export default function StudentAnswerVisibilityControl({
  testId,
  studentId,
  initialMode,
  initialShowExplanations,
}: Props) {
  const t = useTranslations("answerVisibility");
  const router = useRouter();
  const [mode, setMode] = useState<StudentAnswerMode>(initialMode);
  const [showExplanations, setShowExplanations] = useState(initialShowExplanations);
  const [busy, setBusy] = useState(false);

  async function save(next: { mode: StudentAnswerMode; showExplanations: boolean }) {
    const prev = { mode, showExplanations };
    setMode(next.mode);
    setShowExplanations(next.showExplanations);
    setBusy(true);
    try {
      const res = await fetch(`/api/teacher/tests/${testId}/student-answer-visibility`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, ...next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error ?? t("saveFailed"));
        setMode(prev.mode);
        setShowExplanations(prev.showExplanations);
        return;
      }
      router.refresh();
    } catch {
      alert(t("networkError"));
      setMode(prev.mode);
      setShowExplanations(prev.showExplanations);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <select
        value={mode}
        disabled={busy}
        aria-label={t("column")}
        onChange={(e) => save({ mode: e.target.value as StudentAnswerMode, showExplanations })}
        className="w-full min-w-[150px] rounded-lg border border-divider bg-surface px-2 py-1 text-xs text-charcoal disabled:opacity-60"
      >
        <option value="follow">{t("modeFollow")}</option>
        <option value="show">{t("modeShow")}</option>
        <option value="hide">{t("modeHide")}</option>
      </select>
      {mode === "show" && (
        <label className="flex items-center gap-1.5 text-[11px] text-mid-gray">
          <input
            type="checkbox"
            checked={showExplanations}
            disabled={busy}
            onChange={(e) => save({ mode, showExplanations: e.target.checked })}
          />
          {t("alsoExplanations")}
        </label>
      )}
    </div>
  );
}
