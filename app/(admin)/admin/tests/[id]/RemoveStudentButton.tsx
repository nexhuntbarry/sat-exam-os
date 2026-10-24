"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserMinus, X } from "lucide-react";

interface Props {
  testId: string;
  studentId: string;
  studentName: string;
  /** Submissions this student has on this test (any status). */
  submissionCount: number;
  /** True when at least one of them is graded (Submitted / Late). */
  hasGradedSubmission: boolean;
}

export default function RemoveStudentButton({
  testId,
  studentId,
  studentName,
  submissionCount,
  hasGradedSubmission,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // An unfinished attempt is almost always junk once the test is taken
  // away, so default to deleting it; graded results default to kept.
  const [deleteSubs, setDeleteSubs] = useState(submissionCount > 0 && !hasGradedSubmission);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Removed, but the modal stays up to show the class-group warning.
  // Refresh only on close: refreshing drops this row and unmounts us.
  const [done, setDone] = useState(false);
  const [, startTransition] = useTransition();

  async function confirm() {
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/tests/${testId}/remove-students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds: [studentId], deleteSubmissions: deleteSubs }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(j.error ?? "Failed to remove student");
        return;
      }
      if ((j.stillVisibleViaGroup ?? []).includes(studentId)) {
        // Keep the modal open so the admin actually reads this.
        setMessage(
          `${studentName} was removed, but is in a class group assigned to this test, so they can still see it. Remove the class group from the test (or the student from the group) to hide it.`,
        );
        setDone(true);
        return;
      }
      setOpen(false);
      startTransition(() => router.refresh());
    } catch {
      setMessage("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    setOpen(false);
    if (done) startTransition(() => router.refresh());
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`Remove ${studentName} from this test`}
        className="flex items-center gap-1 text-xs text-soft-mute hover:text-status-error transition-colors"
      >
        <UserMinus size={13} />
        Remove
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-divider">
              <h2 className="font-bold text-charcoal text-lg">Remove student from test?</h2>
              <button onClick={close} className="text-soft-mute hover:text-charcoal">
                <X size={20} />
              </button>
            </div>
            <div className="p-5 space-y-4 text-sm text-charcoal">
              <p>
                <span className="font-semibold">{studentName}</span> will no longer see this test on
                their dashboard.
              </p>
              {submissionCount > 0 && (
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteSubs}
                    onChange={(e) => setDeleteSubs(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Also delete their {submissionCount} submission{submissionCount === 1 ? "" : "s"} for
                    this test
                    {hasGradedSubmission && (
                      <span className="block text-status-error text-xs mt-0.5">
                        Includes graded results — this can&rsquo;t be undone.
                      </span>
                    )}
                  </span>
                </label>
              )}
              {message && (
                <p className={done ? "text-warm-amber-dark text-xs" : "text-status-error text-xs"}>
                  {message}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 p-5 border-t border-divider">
              <button
                onClick={close}
                className="px-4 py-2 rounded-xl text-sm text-soft-mute hover:text-charcoal"
              >
                {done ? "Close" : "Cancel"}
              </button>
              <button
                onClick={confirm}
                disabled={submitting || done}
                className="px-4 py-2 rounded-xl bg-status-error hover:opacity-90 text-white font-semibold text-sm disabled:opacity-50"
              >
                {submitting ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
