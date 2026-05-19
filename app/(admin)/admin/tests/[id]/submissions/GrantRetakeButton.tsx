"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Check } from "lucide-react";

interface Props {
  testId: string;
  studentId: string;
  studentName: string;
  alreadyPending: boolean;
}

export default function GrantRetakeButton({
  testId,
  studentId,
  studentName,
  alreadyPending,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  if (alreadyPending) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warm-amber/15 text-warm-amber text-[11px] font-medium"
        title="Student has an unconsumed retake grant — they will start a fresh attempt next time they open this test."
      >
        <Check size={11} />
        Retake granted
      </span>
    );
  }

  async function grant() {
    if (!confirm(`Grant ${studentName} a retake on this test?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/tests/${testId}/grant-retake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(j.error ?? "Failed to grant retake");
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={grant}
      disabled={busy}
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-warm-coral/10 hover:bg-warm-coral/20 text-warm-coral text-xs font-medium transition-colors disabled:opacity-40"
      title="Lets this student start one fresh attempt"
    >
      <RefreshCw size={11} />
      {busy ? "…" : "Grant retake"}
    </button>
  );
}
