"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Send, Trash2 } from "lucide-react";

interface Props {
  attemptKey: string;
  submissionIds: string[];
  mode: "attempt" | "single";
  isInProgress?: boolean;
}

export default function SubmissionRowActions({
  submissionIds,
  mode,
  isInProgress = false,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(action: string, method: "POST" | "DELETE", confirmMsg: string) {
    if (!confirm(confirmMsg)) return;
    setBusy(action);
    setError(null);
    try {
      for (const id of submissionIds) {
        const path =
          method === "DELETE"
            ? `/api/admin/submissions/${id}`
            : `/api/admin/submissions/${id}/${action}`;
        const res = await fetch(path, { method });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  if (mode === "attempt") {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={() =>
            call(
              "delete",
              "DELETE",
              `Delete the entire attempt (${submissionIds.length} submission${submissionIds.length === 1 ? "" : "s"})? This wipes Module 1 + Module 2 if both exist. Cannot be undone.`,
            )
          }
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-status-error/10 hover:bg-status-error/20 text-status-error text-xs font-semibold disabled:opacity-40"
        >
          <Trash2 size={11} />
          {busy === "delete" ? "Deleting…" : "Delete attempt"}
        </button>
        {error && <span className="text-status-error text-xs">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() =>
          call(
            "reset",
            "POST",
            "Reset this submission's answers and restart its timer? The submission row stays but its answers are wiped.",
          )
        }
        disabled={busy !== null}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-light-bg hover:bg-divider text-charcoal text-xs font-medium disabled:opacity-40"
        title="Reset answers, restart timer (keeps the submission row)"
      >
        <RotateCcw size={11} />
        {busy === "reset" ? "…" : "Reset"}
      </button>
      {isInProgress && (
        <button
          onClick={() =>
            call(
              "force-submit",
              "POST",
              "Force submit using the current saved answers? Grades and closes the submission now.",
            )
          }
          disabled={busy !== null}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-warm-amber/15 hover:bg-warm-amber/25 text-warm-amber text-xs font-medium disabled:opacity-40"
          title="Grade and close this In-Progress submission now"
        >
          <Send size={11} />
          {busy === "force-submit" ? "…" : "Force submit"}
        </button>
      )}
      <button
        onClick={() =>
          call(
            "delete",
            "DELETE",
            "Delete just this submission row? If part of a 2-module attempt, the OTHER module's submission stays. Use 'Delete attempt' above to wipe both.",
          )
        }
        disabled={busy !== null}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-status-error/10 hover:bg-status-error/20 text-status-error text-xs font-medium disabled:opacity-40"
        title="Hard-delete this submission row"
      >
        <Trash2 size={11} />
        {busy === "delete" ? "…" : "Delete"}
      </button>
      {error && <span className="text-status-error text-xs ml-1">{error}</span>}
    </div>
  );
}
