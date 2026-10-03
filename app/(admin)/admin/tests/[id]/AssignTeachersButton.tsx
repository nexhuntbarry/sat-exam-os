"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Users, X, CheckCircle2 } from "lucide-react";

interface Teacher {
  id: string;
  display_name: string | null;
  email: string;
}

interface Props {
  testId: string;
  allTeachers: Teacher[];
  currentTeacherIds: string[];
}

// Add or remove teachers on an existing test (method A — direct assignment
// via test_assignments.teacher_ids). PATCHes the FULL desired set, so
// toggling a teacher off removes them.
export default function AssignTeachersButton({ testId, allTeachers, currentTeacherIds }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(currentTeacherIds));
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/tests/${testId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacherIds: Array.from(selected) }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok) {
        setToast("Saved");
        startTransition(() => router.refresh());
        setTimeout(() => { setOpen(false); setToast(null); }, 900);
      } else {
        setToast(j.error ?? "Failed");
      }
    } catch {
      setToast("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => { setSelected(new Set(currentTeacherIds)); setOpen(true); }}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-divider text-mid-gray hover:text-charcoal hover:border-warm-coral/40 text-sm font-medium transition-colors"
      >
        <Users size={14} />
        Assign teachers
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between p-5 border-b border-divider">
              <div>
                <h2 className="font-bold text-charcoal text-lg">Assign teachers</h2>
                <p className="text-soft-mute text-xs mt-0.5">
                  Selected teachers can view this test&rsquo;s results and run the class review.
                </p>
              </div>
              <button onClick={() => setOpen(false)} className="text-soft-mute hover:text-charcoal">
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {allTeachers.length === 0 ? (
                <p className="text-center text-soft-mute text-sm py-8">No teachers found.</p>
              ) : (
                allTeachers.map((tch) => {
                  const isSelected = selected.has(tch.id);
                  return (
                    <button
                      key={tch.id}
                      onClick={() => toggle(tch.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                        isSelected ? "bg-warm-coral/15 text-charcoal" : "hover:bg-light-bg text-charcoal"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{tch.display_name ?? "—"}</div>
                        <div className="text-xs text-soft-mute truncate">{tch.email}</div>
                      </div>
                      <span
                        className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                          isSelected ? "bg-warm-coral border-warm-coral" : "border-divider"
                        }`}
                      >
                        {isSelected && <CheckCircle2 size={12} className="text-white" />}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            <div className="p-5 border-t border-divider flex items-center justify-between gap-3">
              <span className="text-xs text-soft-mute">{selected.size} selected</span>
              <div className="flex items-center gap-2">
                {toast && <span className="text-xs text-warm-coral font-medium">{toast}</span>}
                <button
                  onClick={() => setOpen(false)}
                  className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={submit}
                  disabled={submitting}
                  className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors disabled:opacity-50"
                >
                  {submitting ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
