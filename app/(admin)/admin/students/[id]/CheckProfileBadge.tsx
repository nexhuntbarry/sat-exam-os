"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  studentId: string;
  reason: string;
}

export default function CheckProfileBadge({ studentId, reason }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleMarkChecked() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/students/${studentId}/check-profile`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError((j as { error?: string }).error ?? "Failed to clear flag");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span
        className="inline-flex items-center px-2 py-1 rounded-lg bg-warm-amber/20 text-warm-amber text-xs font-semibold"
        title={reason}
      >
        Check profile
      </span>
      <span className="text-xs text-soft-mute">{reason}</span>
      <button
        onClick={handleMarkChecked}
        disabled={loading}
        className="text-xs px-2.5 py-1 rounded-lg border border-divider text-mid-gray hover:text-charcoal transition-colors disabled:opacity-50"
      >
        {loading ? "Clearing…" : "Mark as checked"}
      </button>
      {error && <span className="text-xs text-status-error">{error}</span>}
    </div>
  );
}
