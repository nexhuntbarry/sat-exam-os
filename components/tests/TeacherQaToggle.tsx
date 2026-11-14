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
  loadError = null,
  fullLengthSection = false,
}: {
  testId: string;
  /** null = the current value couldn't be read (shown as unknown with loadError). */
  initialEnabled: boolean | null;
  loadError?: string | null;
  /** Shown on a full-length section: the switch belongs to the parent test. */
  fullLengthSection?: boolean;
}) {
  const t = useTranslations("teacherQa");
  const router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(loadError);
  const [, startTransition] = useTransition();

  async function set(next: boolean) {
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
    <div className="flex items-start justify-between gap-3" data-teacher-qa-toggle={enabled == null ? "unknown" : enabled ? "on" : "off"}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-charcoal font-semibold text-sm">
          <Printer size={15} className={clsx("shrink-0", enabled ? "text-warm-amber" : "text-soft-mute")} />
          {t("toggleTitle")}: {enabled == null ? t("unknown") : enabled ? t("stateOn") : t("stateOff")}
        </div>
        <p className="text-soft-mute text-xs mt-0.5">
          {enabled == null ? "" : enabled ? t("helpOn") : t("helpOff")} {t("separateNote")}
          {fullLengthSection && <> {t("fullLengthNote")}</>}
        </p>
        {error && <p className="text-status-error text-xs mt-1" role="alert">{error}</p>}
      </div>
      {enabled == null ? (
        // Unknown: let the admin set either value explicitly.
        <span className="shrink-0 inline-flex gap-1.5">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              onClick={() => set(v)}
              disabled={busy}
              className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold bg-light-bg text-charcoal hover:bg-divider transition-colors disabled:opacity-50"
            >
              {busy ? "…" : v ? t("turnOn") : t("turnOff")}
            </button>
          ))}
        </span>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t("toggleTitle")}
          onClick={() => set(!enabled)}
          disabled={busy}
          className={clsx(
            "shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50",
            enabled ? "bg-light-bg text-charcoal hover:bg-divider" : "bg-warm-coral text-white hover:bg-warm-coral-dark",
          )}
        >
          {busy ? "…" : enabled ? t("turnOff") : t("turnOn")}
        </button>
      )}
    </div>
  );
}
