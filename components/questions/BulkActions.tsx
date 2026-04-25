"use client";

import { useState } from "react";
import { CheckCheck, XCircle } from "lucide-react";
import { clsx } from "clsx";

interface BulkActionsProps {
  selectedIds: string[];
  onComplete: () => void;
}

export default function BulkActions({ selectedIds, onComplete }: BulkActionsProps) {
  const [loading, setLoading] = useState<"approve" | "reject" | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const count = selectedIds.length;

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  async function handleBulkApprove() {
    if (count === 0) return;
    setLoading("approve");
    try {
      const res = await fetch("/api/admin/questions/bulk-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_ids: selectedIds }),
      });
      const json = await res.json();
      if (res.ok) {
        showToast(`Approved ${json.approved} questions`);
        onComplete();
      } else {
        showToast(json.error ?? "Approve failed");
      }
    } catch {
      showToast("Network error");
    } finally {
      setLoading(null);
    }
  }

  async function handleBulkReject() {
    if (count === 0) return;
    setLoading("reject");
    try {
      const res = await fetch("/api/admin/questions/bulk-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_ids: selectedIds }),
      });
      // Reject individually — call each
      const results = await Promise.allSettled(
        selectedIds.map((id) =>
          fetch(`/api/admin/questions/${id}/reject`, { method: "POST" })
        )
      );
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      showToast(`Rejected ${succeeded} questions`);
      onComplete();
    } catch {
      showToast("Network error");
    } finally {
      setLoading(null);
    }
  }

  if (count === 0) return null;

  return (
    <div className="flex items-center gap-3">
      {toast && (
        <span className="text-xs text-mid-gray bg-light-bg px-3 py-1.5 rounded-lg">
          {toast}
        </span>
      )}
      <span className="text-xs text-soft-mute">{count} selected</span>
      <button
        onClick={handleBulkApprove}
        disabled={loading !== null}
        className={clsx(
          "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
          "bg-warm-amber/15 text-warm-amber hover:bg-warm-amber/25 disabled:opacity-50"
        )}
      >
        <CheckCheck size={13} />
        {loading === "approve" ? "Approving..." : "Approve All"}
      </button>
      <button
        onClick={handleBulkReject}
        disabled={loading !== null}
        className={clsx(
          "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
          "bg-status-error/15 text-status-error hover:bg-status-error/25 disabled:opacity-50"
        )}
      >
        <XCircle size={13} />
        {loading === "reject" ? "Rejecting..." : "Reject All"}
      </button>
    </div>
  );
}
