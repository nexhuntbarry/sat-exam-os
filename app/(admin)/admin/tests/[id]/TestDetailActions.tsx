"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Lock, Trash2, AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  testId: string;
  testName: string;
  status: string;
  submissionCount: number;
  gradedCount: number;
}

export default function TestDetailActions({ testId, testName, status, submissionCount, gradedCount }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleAction(action: "publish" | "close" | "reopen") {
    setLoading(action);
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/tests/${testId}/${action}`, { method: "POST" });
      if (res.ok) {
        router.refresh();
      } else {
        const j = await res.json().catch(() => ({}));
        setActionError(j.error ?? `Failed (HTTP ${res.status})`);
      }
    } catch {
      setActionError("Network error");
    } finally {
      setLoading(null);
    }
  }

  async function confirmDelete() {
    setDeleteError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/tests/${testId}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setDeleteError(j.error ?? "Failed to delete");
        return;
      }
      router.push("/admin/tests");
      router.refresh();
    } catch {
      setDeleteError("Network error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        {status === "Draft" && (
          <button
            disabled={loading === "publish"}
            onClick={() => handleAction("publish")}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-amber hover:bg-warm-amber/90 text-charcoal font-semibold text-sm transition-colors disabled:opacity-50"
          >
            <Send size={14} />
            {loading === "publish" ? "Publishing..." : "Publish"}
          </button>
        )}
        {status === "Published" && (
          <button
            disabled={loading === "close"}
            onClick={() => handleAction("close")}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-status-error/15 hover:bg-status-error/30 text-status-error font-semibold text-sm transition-colors disabled:opacity-50"
          >
            <Lock size={14} />
            {loading === "close" ? "Closing..." : "Close Test"}
          </button>
        )}
        {status === "Closed" && (
          <button
            disabled={loading === "reopen"}
            onClick={() => handleAction("reopen")}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-amber hover:bg-warm-amber/90 text-charcoal font-semibold text-sm transition-colors disabled:opacity-50"
          >
            <RotateCcw size={14} />
            {loading === "reopen" ? "Reopening..." : "Reopen"}
          </button>
        )}
        <button
          onClick={() => {
            setDeleteOpen(true);
            setDeleteText("");
            setDeleteError(null);
          }}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-status-error/10 hover:bg-status-error/20 text-status-error font-semibold text-sm transition-colors"
          title="Permanently delete this test"
        >
          <Trash2 size={14} />
          Delete
        </button>
        {actionError && (
          <p className="basis-full text-status-error text-xs max-w-sm">{actionError}</p>
        )}
      </div>

      {deleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-5 border-b border-divider flex items-start gap-3">
              <AlertTriangle size={20} className="text-status-error shrink-0 mt-0.5" />
              <div>
                <h3 className="font-bold text-charcoal text-base">Delete this test?</h3>
                <p className="text-mid-gray text-xs mt-0.5 leading-relaxed">
                  This permanently removes <strong>{testName}</strong> along with every
                  submission, answer record, retake grant, and assignment. Cannot be
                  undone.
                </p>
                <p className="text-charcoal text-xs mt-2 font-medium">
                  {submissionCount === 0
                    ? "No student submissions will be deleted."
                    : `This deletes ${submissionCount} submission${submissionCount === 1 ? "" : "s"}` +
                      (gradedCount > 0 ? ` (${gradedCount} already graded).` : ".")}
                </p>
              </div>
            </div>
            <div className="px-5 py-4 space-y-2">
              <label className="block text-charcoal text-sm font-medium">
                Type the test name to confirm:{" "}
                <span className="font-mono text-warm-coral-text">{testName}</span>
              </label>
              <input
                value={deleteText}
                onChange={(e) => setDeleteText(e.target.value)}
                className="w-full bg-light-bg border border-divider rounded-xl px-3 py-2 text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-status-error/50"
                placeholder={testName}
                autoFocus
              />
              {deleteError && (
                <p className="text-status-error text-sm">{deleteError}</p>
              )}
            </div>
            <div className="p-5 border-t border-divider flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  setDeleteOpen(false);
                  setDeleteText("");
                }}
                className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleteText.trim() !== testName.trim() || deleting}
                className="px-4 py-2 rounded-xl bg-status-error hover:bg-status-error/90 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deleting ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
