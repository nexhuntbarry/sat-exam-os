"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquareWarning, X } from "lucide-react";
import {
  STUDENT_REPORT_KINDS,
  STUDENT_REPORT_KIND_LABEL,
  STUDENT_REPORT_NOTE_MAX,
  type StudentReportContext,
  type StudentReportKind,
} from "@/lib/student-reports-shared";

const SEND_TIMEOUT_MS = 10_000;

interface Props {
  testId: string;
  questionId: string;
  submissionId?: string | null;
  context: StudentReportContext;
  /** 1-based position shown to the student (take page). */
  displayNumber?: number;
  /** Lets the take page pause its keyboard shortcuts while the dialog is open. */
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/**
 * Small "Report a problem" link + dialog. Fully independent of the exam:
 * it holds its own state, sends one fire-and-forget POST and never touches
 * answers, autosave, the timer or navigation. Every key pressed inside the
 * dialog is stopped at the dialog so exam shortcuts (A–D, N/P, F, Enter)
 * never fire while the student types a note.
 */
export default function ReportProblemButton({
  testId,
  questionId,
  submissionId,
  context,
  displayNumber,
  onOpenChange,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<StudentReportKind | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  function setDialog(next: boolean) {
    setOpen(next);
    onOpenChangeRef.current?.(next);
  }

  function openDialog() {
    setKind(null);
    setNote("");
    setError("");
    setSent(false);
    setDialog(true);
  }

  function close() {
    setDialog(false);
    triggerRef.current?.focus();
  }

  // The Send button unmounts on success; keep focus inside the dialog.
  useEffect(() => {
    if (sent) dialogRef.current?.querySelector<HTMLElement>("[data-report-done]")?.focus();
  }, [sent]);

  // Tell the parent the dialog is gone if this unmounts while open
  // (question change, auto-submit navigation).
  useEffect(() => () => onOpenChangeRef.current?.(false), []);

  // Native listener on the dialog itself: stop every key from bubbling to
  // the window-level exam shortcut handler, handle Esc and keep Tab inside.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.querySelector<HTMLElement>("input[type=radio]")?.focus();
    function onKeyDown(e: KeyboardEvent) {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>("button:not([disabled]), textarea, input"),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    // Esc must work even when focus has left the dialog (e.g. the Send
    // button was disabled while sending and focus fell back to <body>).
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || dialog?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    dialog.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onDocKeyDown, true);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onDocKeyDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function send() {
    if (!kind) {
      setError("Pick the type of problem.");
      return;
    }
    setBusy(true);
    setError("");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch("/api/student/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testId,
          questionId,
          submissionId: submissionId ?? null,
          kind,
          note: note.trim(),
          context,
          displayNumber,
        }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(
          res.status === 429 || res.status === 403
            ? data?.error ?? "Couldn't send the report."
            : "Couldn't send the report. You can keep working and try again later.",
        );
        return;
      }
      setSent(true);
    } catch {
      setError("Couldn't send the report. You can keep working and try again later.");
    } finally {
      clearTimeout(timer);
      setBusy(false);
      // Keep focus inside the dialog (the disabled Send button dropped it).
      requestAnimationFrame(() => {
        const d = dialogRef.current;
        if (d && !d.contains(document.activeElement)) {
          d.querySelector<HTMLElement>("[data-report-done], textarea, button:not([disabled])")?.focus();
        }
      });
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openDialog}
        className={
          className ??
          "inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-soft-mute hover:text-charcoal hover:bg-light-bg transition-colors"
        }
        aria-haspopup="dialog"
        aria-label="Report a problem"
        title="Report a problem"
      >
        <MessageSquareWarning size={13} aria-hidden="true" />
        {/* Icon-only on phones so the exam header doesn't crowd. */}
        <span className="hidden sm:inline whitespace-nowrap">Report a problem</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] bg-black/30 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) close();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`report-title-${questionId}`}
            data-report-dialog=""
            className="bg-cream w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4 text-left"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id={`report-title-${questionId}`} className="text-charcoal font-semibold">
                  Report a problem{displayNumber ? ` with question ${displayNumber}` : ""}
                </h2>
                <p className="text-soft-mute text-xs mt-0.5">
                  Your answers and timer are not affected. A staff member will check it.
                </p>
              </div>
              <button type="button" onClick={close} className="text-soft-mute hover:text-charcoal p-1" aria-label="Close">
                <X size={16} />
              </button>
            </div>

            {sent ? (
              <div className="space-y-4">
                <p className="text-sm text-charcoal" role="status">
                  Thanks, your report was sent.
                </p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    data-report-done=""
                    onClick={close}
                    className="px-4 py-2 rounded-xl bg-charcoal text-cream text-sm font-semibold hover:bg-charcoal/90"
                  >
                    Back to the question
                  </button>
                </div>
              </div>
            ) : (
              <>
                <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium text-charcoal mb-1">What&apos;s wrong?</legend>
                  {STUDENT_REPORT_KINDS.map((k) => (
                    <label
                      key={k}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg border border-divider bg-surface text-sm text-charcoal cursor-pointer has-[:checked]:border-warm-coral has-[:checked]:bg-warm-coral/5"
                    >
                      <input
                        type="radio"
                        name={`report-kind-${questionId}`}
                        value={k}
                        checked={kind === k}
                        onChange={() => setKind(k)}
                        className="accent-warm-coral"
                      />
                      {STUDENT_REPORT_KIND_LABEL[k]}
                    </label>
                  ))}
                </fieldset>
                <div>
                  <label htmlFor={`report-note-${questionId}`} className="text-sm font-medium text-charcoal">
                    Note <span className="text-soft-mute font-normal">(optional)</span>
                  </label>
                  <textarea
                    id={`report-note-${questionId}`}
                    value={note}
                    onChange={(e) => setNote(e.target.value.slice(0, STUDENT_REPORT_NOTE_MAX))}
                    maxLength={STUDENT_REPORT_NOTE_MAX}
                    rows={3}
                    placeholder="What did you see?"
                    className="mt-1 w-full rounded-lg border border-divider bg-surface px-3 py-2 text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-warm-coral/40"
                  />
                  <div className="text-[11px] text-soft-mute text-right">
                    {note.length}/{STUDENT_REPORT_NOTE_MAX}
                  </div>
                </div>
                {error && (
                  <p className="text-sm text-status-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    className="px-4 py-2 rounded-xl border border-divider text-sm text-mid-gray hover:text-charcoal"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={send}
                    disabled={busy}
                    className="px-4 py-2 rounded-xl bg-warm-coral text-white text-sm font-semibold hover:bg-warm-coral-dark disabled:opacity-50"
                  >
                    {busy ? "Sending..." : "Send report"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
