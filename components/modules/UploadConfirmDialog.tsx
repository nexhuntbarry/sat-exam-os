"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";

interface UploadConfirmDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

const CHECK_KEYS = ["check1", "check2", "check3", "check4", "check5", "check6"] as const;

export default function UploadConfirmDialog({ onConfirm, onCancel }: UploadConfirmDialogProps) {
  const t = useTranslations("admin.modules.uploadConfirm");
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CHECK_KEYS.map((k) => [k, false])),
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  const allChecked = CHECK_KEYS.every((k) => checked[k]);

  function toggle(key: string) {
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // Focus trap + Esc to close
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onCancelRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input[type='checkbox'], [href], [tabindex]:not([tabindex='-1'])",
        ),
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !dialog.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-confirm-title"
        className="relative bg-cream border border-divider rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-divider px-5 py-4">
          <div>
            <h2 id="upload-confirm-title" className="text-charcoal font-semibold text-lg">
              {t("title")}
            </h2>
            <p className="text-soft-mute text-sm mt-0.5">{t("subtitle")}</p>
          </div>
          <button
            onClick={onCancel}
            className="text-soft-mute hover:text-charcoal transition-colors"
            aria-label={t("cancel")}
          >
            <X size={18} />
          </button>
        </div>

        {/* Checklist */}
        <div className="px-5 py-4 space-y-3 overflow-y-auto max-h-[60vh]">
          {CHECK_KEYS.map((key) => {
            const id = `upload-check-${key}`;
            return (
              <div key={key} className="flex items-start gap-3">
                <input
                  id={id}
                  type="checkbox"
                  checked={checked[key]}
                  onChange={() => toggle(key)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-warm-coral cursor-pointer"
                />
                <label htmlFor={id} className="text-charcoal text-sm leading-relaxed cursor-pointer">
                  {t(key)}
                </label>
              </div>
            );
          })}

          {/* Note */}
          <p className="text-soft-mute text-xs pt-1 border-t border-divider mt-2">
            {t("note")}
          </p>
        </div>

        {/* Footer */}
        <div className="border-t border-divider px-5 py-4 flex gap-3 justify-end">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm font-medium transition-colors"
          >
            {t("cancel")}
          </button>
          <button
            onClick={onConfirm}
            disabled={!allChecked}
            className="px-5 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
