"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, AlertTriangle } from "lucide-react";

interface Props {
  studentId: string;
  studentName: string;
  email: string;
}

export default function DeleteStudentButton({ studentId, studentName, email }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = text.trim() === email.trim();

  async function confirm() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/students/${studentId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? "Failed to delete");
        return;
      }
      router.push("/admin/students");
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          setText("");
          setError(null);
        }}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-status-error/10 hover:bg-status-error/20 text-status-error text-sm font-medium transition-colors"
      >
        <Trash2 size={14} />
        Delete student
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-5 border-b border-divider flex items-start gap-3">
              <AlertTriangle size={20} className="text-status-error shrink-0 mt-0.5" />
              <div>
                <h3 className="font-bold text-charcoal text-base">Delete this student?</h3>
                <p className="text-mid-gray text-xs mt-0.5 leading-relaxed">
                  This permanently removes <strong>{studentName}</strong> ({email}) along with
                  every submission, answer record, profile, class membership, and retake grant
                  attached to them. This cannot be undone. Consider Suspend instead unless the
                  student must be hard-deleted (e.g. duplicate account, GDPR request).
                </p>
              </div>
            </div>
            <div className="px-5 py-4 space-y-2">
              <label className="block text-charcoal text-sm font-medium">
                Type the student&rsquo;s email to confirm:{" "}
                <span className="font-mono text-warm-coral">{email}</span>
              </label>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-full bg-light-bg border border-divider rounded-xl px-3 py-2 text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-status-error/50"
                placeholder="email@example.com"
                autoFocus
              />
              {error && <p className="text-status-error text-sm">{error}</p>}
            </div>
            <div className="p-5 border-t border-divider flex items-center justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirm}
                disabled={!matches || submitting}
                className="px-4 py-2 rounded-xl bg-status-error hover:bg-status-error/90 text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
