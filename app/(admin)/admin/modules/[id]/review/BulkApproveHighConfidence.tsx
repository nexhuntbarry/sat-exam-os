"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";

interface BulkApproveHighConfidenceProps {
  moduleId: string;
}

export default function BulkApproveHighConfidence({ moduleId }: BulkApproveHighConfidenceProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  async function handleBulkApprove() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    setConfirming(false);
    setLoading(true);
    try {
      const res = await fetch("/api/admin/questions/bulk-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter: { moduleId, minConfidence: 0.85 },
        }),
      });
      const json = await res.json();
      if (res.ok) {
        showToast(`Approved ${json.approved} high-confidence questions`);
        router.refresh();
      } else {
        showToast(json.error ?? "Failed");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {toast && (
        <span className="text-xs text-mid-gray bg-light-bg px-3 py-1.5 rounded-lg">{toast}</span>
      )}
      <button
        onClick={handleBulkApprove}
        disabled={loading}
        className="flex items-center gap-2 px-3 py-2 rounded-xl bg-warm-amber/15 hover:bg-warm-amber/25 text-warm-amber text-sm font-medium transition-colors disabled:opacity-50"
      >
        <CheckCheck size={14} />
        {loading
          ? "Approving..."
          : confirming
          ? "Click again to confirm"
          : "Approve all (conf. > 85%)"}
      </button>
    </div>
  );
}
