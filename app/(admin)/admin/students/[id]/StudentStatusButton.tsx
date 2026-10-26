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
export default function StudentStatusButton({ studentId, studentName, status }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (status !== "approved" && status !== "suspended") return null;
  const suspending = status === "approved";

  async function run() {
    let body: Record<string, unknown> = {};
    if (suspending) {
      const reason = prompt(`Suspend ${studentName}? They will lose access until reactivated.\n\nReason (optional):`);
      if (reason === null) return;
      body = { reason };
    } else if (!confirm(`Reactivate ${studentName}?`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/students/${studentId}/${suspending ? "suspend" : "approve"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Failed");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
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
