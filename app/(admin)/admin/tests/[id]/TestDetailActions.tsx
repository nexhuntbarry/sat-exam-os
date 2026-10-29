"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Send, Lock, Trash2, AlertTriangle, RotateCcw, MoreHorizontal, ClipboardList } from "lucide-react";

interface Props {
  testId: string;
  testName: string;
  status: string;
  submissionCount: number;
  gradedCount: number;
}

// Publish stays a visible button on drafts; Manage submissions, Close /
// Reopen and Delete live in a "More" menu. Close and Delete confirm first.
export default function TestDetailActions({ testId, testName, status, submissionCount, gradedCount }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  async function handleAction(action: "publish" | "close" | "reopen") {
    setLoading(action);
    setActionError(null);
    try {
      const res = await fetch(`/api/admin/tests/${testId}/${action}`, { method: "POST" });
      if (res.ok) {
        setCloseOpen(false);
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

  const itemClass =
    "w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-light-bg transition-colors disabled:opacity-50";

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
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-light-bg hover:bg-divider text-charcoal font-semibold text-sm transition-colors"
          >
            <MoreHorizontal size={16} />
            More
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 z-40 w-56 bg-surface border border-divider rounded-xl shadow-lg py-1"
            >
              <Link
                href={`/admin/tests/${testId}/manage-submissions`}
                role="menuitem"
                className={`${itemClass} text-charcoal`}
                title="Reset / force-submit / delete student submissions"
              >
                <ClipboardList size={14} />
                Manage submissions
              </Link>
              {status === "Published" && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setActionError(null);
                    setCloseOpen(true);
                  }}
                  className={`${itemClass} text-status-error`}
                >
                  <Lock size={14} />
                  Close Test
                </button>
              )}
              {status === "Closed" && (
                <button
                  role="menuitem"
                  disabled={loading === "reopen"}
                  onClick={() => {
                    setMenuOpen(false);
                    handleAction("reopen");
                  }}
                  className={`${itemClass} text-charcoal`}
                >
                  <RotateCcw size={14} />
                  {loading === "reopen" ? "Reopening..." : "Reopen"}
                </button>
              )}
              <div className="my-1 border-t border-divider" />
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setDeleteOpen(true);
                  setDeleteText("");
                  setDeleteError(null);
                }}
                className={`${itemClass} text-status-error`}
                title="Permanently delete this test"
              >
                <Trash2 size={14} />
                Delete
              </button>
            </div>
          )}
        </div>
        {actionError && !closeOpen && (
          <p className="basis-full text-status-error text-xs max-w-sm">{actionError}</p>
        )}
      </div>

      {closeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-5 border-b border-divider flex items-start gap-3">
              <Lock size={20} className="text-status-error shrink-0 mt-0.5" />
              <div>
                <h3 className="font-bold text-charcoal text-base">Close this test?</h3>
                <p className="text-mid-gray text-xs mt-0.5 leading-relaxed">
                  Students can no longer start <strong>{testName}</strong>. Submissions and results are
                  kept, and you can reopen it later from More.
                </p>
              </div>
            </div>
            {actionError && <p className="px-5 pt-4 text-status-error text-sm">{actionError}</p>}
            <div className="p-5 flex items-center justify-end gap-2">
              <button
                onClick={() => setCloseOpen(false)}
                className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleAction("close")}
                disabled={loading === "close"}
                className="px-4 py-2 rounded-xl bg-status-error hover:bg-status-error/90 text-white font-semibold text-sm transition-colors disabled:opacity-40"
              >
                {loading === "close" ? "Closing..." : "Close Test"}
              </button>
            </div>
          </div>
        </div>
      )}

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
