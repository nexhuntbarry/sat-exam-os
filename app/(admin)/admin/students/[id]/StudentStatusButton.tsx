"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, RotateCcw } from "lucide-react";

interface Props {
  studentId: string;
  studentName: string;
  /** users.account_status — only "approved" and "suspended" render a button. */
  status: string;
}

// Suspend an approved student or reactivate a suspended one. Reactivation
// goes through the approve route (it flips account_status back to
// approved without re-sending the welcome email).
/**
 * Prompt/confirm, then suspend (approved) or reactivate (suspended) a
 * student. Returns null if the admin cancelled, otherwise the outcome.
 * Shared with the Students list ⋯ menu.
 */
export async function changeStudentStatus(
  { studentId, studentName, status }: Props,
  onStart?: () => void,
): Promise<{ ok: true } | { ok: false; error: string } | null> {
  if (status !== "approved" && status !== "suspended") return null;
  const suspending = status === "approved";
  let body: Record<string, unknown> = {};
  if (suspending) {
    const reason = prompt(`Suspend ${studentName}? They will lose access until reactivated.\n\nReason (optional):`);
    if (reason === null) return null;
    body = { reason };
  } else if (!confirm(`Reactivate ${studentName}?`)) {
    return null;
  }
  onStart?.();
  try {
    const res = await fetch(`/api/admin/students/${studentId}/${suspending ? "suspend" : "approve"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: j.error ?? "Failed" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

export default function StudentStatusButton({ studentId, studentName, status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (status !== "approved" && status !== "suspended") return null;
  const suspending = status === "approved";

  async function run() {
    const result = await changeStudentStatus({ studentId, studentName, status }, () => {
      setBusy(true);
      setError(null);
    });
    setBusy(false);
    if (!result) return;
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        onClick={run}
        disabled={busy}
        className={
          suspending
            ? "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-status-error/10 hover:bg-status-error/15 text-status-error text-xs font-medium transition-colors disabled:opacity-50"
            : "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-warm-amber/15 hover:bg-warm-amber/25 text-charcoal text-xs font-medium transition-colors disabled:opacity-50"
        }
      >
        {suspending ? <Ban size={13} /> : <RotateCcw size={13} />}
        {busy ? "Saving…" : suspending ? "Suspend" : "Reactivate"}
      </button>
      {error && <span className="text-status-error text-xs">{error}</span>}
    </span>
  );
}
