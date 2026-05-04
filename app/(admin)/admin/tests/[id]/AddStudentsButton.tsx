"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, X, Search, CheckCircle2 } from "lucide-react";

interface Student {
  id: string;
  email: string;
  display_name: string | null;
  account_status: string;
  student_profiles?:
    | { grade?: string | null; school?: string | null; class_group?: string | null }
    | { grade?: string | null; school?: string | null; class_group?: string | null }[]
    | null;
}

function getProfileGrade(s: Student): string | null {
  if (!s.student_profiles) return null;
  const p = Array.isArray(s.student_profiles) ? s.student_profiles[0] : s.student_profiles;
  return p?.grade ?? null;
}

interface Props {
  testId: string;
  alreadyAssigned: string[];
}

export default function AddStudentsButton({ testId, alreadyAssigned }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [students, setStudents] = useState<Student[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    setLoading(true);
    fetch(`/api/admin/students?q=${encodeURIComponent(search)}`, {
      signal: ctl.signal,
    })
      .then((r) => r.json())
      .then((j) => setStudents(j.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [open, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/tests/${testId}/add-students`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds: Array.from(selected) }),
      });
      const j = await res.json();
      if (res.ok) {
        setToast(`Added ${j.added} student${j.added === 1 ? "" : "s"}`);
        setSelected(new Set());
        startTransition(() => router.refresh());
        setTimeout(() => {
          setOpen(false);
          setToast(null);
        }, 1200);
      } else {
        setToast(j.error ?? "Failed");
      }
    } catch {
      setToast("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  const assignedSet = new Set(alreadyAssigned);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
      >
        <UserPlus size={14} />
        Add Students
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-surface border border-divider rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between p-5 border-b border-divider">
              <div>
                <h2 className="font-bold text-charcoal text-lg">Add students to this test</h2>
                <p className="text-soft-mute text-xs mt-0.5">
                  Approved students only. Already-assigned students are greyed out.
                </p>
              </div>
              <button
                onClick={() => {
                  setOpen(false);
                  setSelected(new Set());
                }}
                className="text-soft-mute hover:text-charcoal"
              >
                <X size={20} />
              </button>
            </div>

            <div className="px-5 py-3 border-b border-divider">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-soft-mute" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or email"
                  className="w-full pl-9 pr-3 py-2 rounded-xl bg-light-bg border border-divider text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-coral/50"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {loading ? (
                <p className="text-center text-soft-mute text-sm py-8">Loading…</p>
              ) : students.length === 0 ? (
                <p className="text-center text-soft-mute text-sm py-8">No students.</p>
              ) : (
                students.map((s) => {
                  const isAssigned = assignedSet.has(s.id);
                  const isSelected = selected.has(s.id);
                  const grade = getProfileGrade(s);
                  return (
                    <button
                      key={s.id}
                      onClick={() => !isAssigned && toggle(s.id)}
                      disabled={isAssigned}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                        isAssigned
                          ? "bg-light-bg text-soft-mute cursor-not-allowed"
                          : isSelected
                          ? "bg-warm-coral/15 text-charcoal"
                          : "hover:bg-light-bg text-charcoal"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {s.display_name ?? "—"}
                          {grade && (
                            <span className="ml-2 text-xs text-soft-mute font-normal">
                              · Grade {grade}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-soft-mute truncate">{s.email}</div>
                      </div>
                      {isAssigned ? (
                        <span className="text-xs text-soft-mute italic shrink-0">already in</span>
                      ) : (
                        <span
                          className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                            isSelected
                              ? "bg-warm-coral border-warm-coral"
                              : "border-divider"
                          }`}
                        >
                          {isSelected && <CheckCircle2 size={12} className="text-white" />}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            <div className="p-5 border-t border-divider flex items-center justify-between gap-3">
              <span className="text-xs text-soft-mute">
                {selected.size} selected
              </span>
              <div className="flex items-center gap-2">
                {toast && (
                  <span className="text-xs text-warm-coral font-medium">{toast}</span>
                )}
                <button
                  onClick={() => {
                    setOpen(false);
                    setSelected(new Set());
                  }}
                  className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={submit}
                  disabled={submitting || selected.size === 0}
                  className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors disabled:opacity-50"
                >
                  {submitting ? "Adding…" : `Add ${selected.size}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
