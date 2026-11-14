"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Printer } from "lucide-react";
import { clsx } from "clsx";

// Admin switch "Teachers can view & print questions/answers"
// (tests.teacher_qa_enabled via POST /api/admin/tests/[id]/teacher-qa).
// testId is the test that holds the setting: a full-length section passes
// its parent. Separate from ReviewModeToggle (the students' class-review lock).
export default function TeacherQaToggle({
  testId,
  initialEnabled,
  fullLengthSection = false,
}: {
  testId: string;
  initialEnabled: boolean;
  /** Shown on a full-length section: the switch belongs to the parent test. */
  fullLengthSection?: boolean;
}) {
  const t = useTranslations("teacherQa");
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function flip() {
    const next = !enabled;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tests/${testId}/teacher-qa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(res.status === 503 ? t("pending") : j.error ?? t("failed"));
        return;
      }
      setEnabled(next);
      startTransition(() => router.refresh());
    } catch {
      setError(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start justify-between gap-3" data-teacher-qa-toggle={enabled ? "on" : "off"}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-charcoal font-semibold text-sm">
          <Printer size={15} className={clsx("shrink-0", enabled ? "text-warm-amber" : "text-soft-mute")} />
          {t("toggleTitle")}: {enabled ? t("stateOn") : t("stateOff")}
        </div>
        <p className="text-soft-mute text-xs mt-0.5">
          {enabled ? t("helpOn") : t("helpOff")} {t("separateNote")}
          {fullLengthSection && <> {t("fullLengthNote")}</>}
        </p>
        {error && <p className="text-status-error text-xs mt-1" role="alert">{error}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={t("toggleTitle")}
        onClick={flip}
        disabled={busy}
        className={clsx(
          "shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50",
          enabled ? "bg-light-bg text-charcoal hover:bg-divider" : "bg-warm-coral text-white hover:bg-warm-coral-dark",
        )}
      >
        {busy ? "…" : enabled ? t("turnOff") : t("turnOn")}
      </button>
    </div>
  );
}
