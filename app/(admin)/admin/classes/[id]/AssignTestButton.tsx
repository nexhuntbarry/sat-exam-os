"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList, X, Search, CheckCircle2, AlertTriangle } from "lucide-react";
import { Portal } from "@/components/ui/Portal";
import { SubjectTag } from "@/components/ui/StatusBadge";

export interface AvailableTest {
  id: string;
  name: string;
  section: string | null;
  status: string | null;
  openDate: string | null;
  dueDate: string | null;
  /** Current class_group_ids for this test (from test_assignments). */
  currentClassGroupIds: string[];
}

interface Props {
  classGroupId: string;
  availableTests: AvailableTest[];
  memberCount: number;
}

/**
 * "Assign test" button for the class detail page.
 *
 * Uses addClassGroupIds (atomic server-side CAS) instead of a full
 * classGroupIds replacement, so concurrent assign/unassign operations
 * on other pages never silently drop each other's changes.
 */
export default function AssignTestButton({ classGroupId, availableTests, memberCount }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = search.trim().toLowerCase();
  const filtered = availableTests.filter((t) => {
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      (t.section?.toLowerCase().includes(q) ?? false)
    );
  });

  const alreadyAssigned = new Set(
    availableTests.filter((t) => t.currentClassGroupIds.includes(classGroupId)).map((t) => t.id)
  );
  const sorted = [
    ...filtered.filter((t) => !alreadyAssigned.has(t.id)),
    ...filtered.filter((t) => alreadyAssigned.has(t.id)),
  ];

  function toggle(id: string) {
    if (alreadyAssigned.has(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAssign() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    const errors: string[] = [];
    let anySuccess = false;
    try {
      for (const testId of selected) {
        const test = availableTests.find((t) => t.id === testId);
        if (!test) continue;
        // Atomic add: server CAS ensures no concurrent update is overwritten.
        try {
          const res = await fetch(`/api/admin/tests/${testId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ addClassGroupIds: [classGroupId] }),
          });
          if (res.ok) {
            anySuccess = true;
          } else {
            const j = await res.json().catch(() => ({}));
            errors.push(`${test.name}: ${(j as { error?: string }).error ?? "Failed"}`);
          }
        } catch {
          errors.push(`${test.name}: Network error`);
        }
      }
    } finally {
      setSubmitting(false);
    }

    if (anySuccess) {
      startTransition(() => router.refresh());
    }
    if (errors.length > 0) {
      setError(errors.join("; "));
    } else {
      setToast(`Assigned ${selected.size} test${selected.size !== 1 ? "s" : ""} to this class`);
      setSelected(new Set());
      setSearch("");
      setTimeout(() => {
        setOpen(false);
        setToast(null);
      }, 1200);
    }
  }

  function handleClose() {
    setOpen(false);
    setSelected(new Set());
    setSearch("");
    setError(null);
    setToast(null);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white text-sm font-semibold transition-colors"
      >
        <ClipboardList size={14} />
        Assign test
      </button>

      {open && (
        <Portal>
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
            <div className="bg-surface border border-divider rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]">
              {/* Header */}
              <div className="flex items-center justify-between p-5 border-b border-divider">
                <div>
                  <h2 className="font-bold text-charcoal text-lg">Assign test to this class</h2>
                  <p className="text-soft-mute text-xs mt-0.5">
                    All {memberCount} student{memberCount !== 1 ? "s" : ""} in this class will get access.
                  </p>
                </div>
                <button onClick={handleClose} className="text-soft-mute hover:text-charcoal">
                  <X size={20} />
                </button>
              </div>

              {/* Search */}
              <div className="px-5 py-3 border-b border-divider">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-soft-mute" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search tests…"
                    className="w-full pl-9 pr-3 py-2 rounded-xl bg-light-bg border border-divider text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-coral/50"
                    autoFocus
                  />
                </div>
              </div>

              {/* Test list */}
              <div className="flex-1 overflow-y-auto p-3 space-y-1">
                {sorted.length === 0 ? (
                  <p className="text-center text-soft-mute text-sm py-8">
                    {availableTests.length === 0 ? "No tests available." : "No tests match your search."}
                  </p>
                ) : (
                  sorted.map((t) => {
                    const isSelected = selected.has(t.id);
                    const isAssigned = alreadyAssigned.has(t.id);
                    return (
                      <button
                        key={t.id}
                        onClick={() => toggle(t.id)}
                        disabled={isAssigned}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                          isAssigned
                            ? "bg-light-bg text-soft-mute cursor-not-allowed opacity-60"
                            : isSelected
                            ? "bg-warm-coral/15 text-charcoal"
                            : "hover:bg-light-bg text-charcoal"
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <span className="truncate">{t.name}</span>
                            {t.section && <SubjectTag section={t.section} />}
                          </div>
                          <div className="text-xs text-soft-mute mt-0.5">
                            {t.status ?? "Draft"}
                            {t.openDate && ` · Opens ${new Date(t.openDate).toLocaleDateString()}`}
                            {t.dueDate && ` · Due ${new Date(t.dueDate).toLocaleDateString()}`}
                            {isAssigned && " · Already assigned to this class"}
                          </div>
                        </div>
                        {isAssigned ? (
                          <CheckCircle2 size={14} className="text-soft-mute shrink-0" />
                        ) : (
                          <span
                            className={`shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                              isSelected ? "bg-warm-coral border-warm-coral" : "border-divider"
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

              {/* Footer */}
              <div className="p-5 border-t border-divider flex items-center justify-between gap-3">
                <span className="text-xs text-soft-mute">
                  {selected.size} test{selected.size !== 1 ? "s" : ""} selected
                </span>
                <div className="flex items-center gap-2">
                  {error && (
                    <span className="flex items-center gap-1 text-xs text-status-error font-medium">
                      <AlertTriangle size={12} />
                      {error}
                    </span>
                  )}
                  {toast && (
                    <span className="text-xs text-status-success font-medium">{toast}</span>
                  )}
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handleAssign()}
                    disabled={submitting || selected.size === 0}
                    className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors disabled:opacity-50"
                  >
                    {submitting ? "Assigning…" : `Assign ${selected.size > 0 ? selected.size : ""}`}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
