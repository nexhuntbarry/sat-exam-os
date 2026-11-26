"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ClipboardList, Search, X } from "lucide-react";
import { SubjectTag } from "@/components/ui/StatusBadge";
import { clsx } from "clsx";
import { Portal } from "@/components/ui/Portal";
import { nyLocalToIso, plural } from "@/lib/test-assign-shared";
import PublishAtField from "../tests/PublishAtField";
import BulkAssignResultView, { postBulkAssign, type BulkAssignResult } from "../tests/BulkAssignResult";

interface PickTest {
  id: string;
  name: string;
  status: string | null;
  section: string | null;
}

// Assign one or more tests to one or more students (ticket b271dd38): the
// Students list (row action + bulk bar) and the student detail page. Picks
// stay checked while the search changes; Closed tests can't be picked; Drafts
// can, with an optional publish time. One request (/api/admin/tests/bulk-assign)
// skips pairs already assigned and returns the summary shown at the end.
export default function AssignTestsDialog({
  studentIds,
  studentNames,
  alreadyAssigned,
  onClose,
  onDone,
}: {
  studentIds: string[];
  studentNames: string[];
  /** Tests the (single) student already has: shown greyed out. */
  alreadyAssigned?: string[];
  onClose: () => void;
  /** After a successful assign, when the admin closes the summary. */
  onDone: () => void;
}) {
  const [search, setSearch] = useState("");
  const [tests, setTests] = useState<PickTest[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickTest[]>([]);
  const [publishLocal, setPublishLocal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkAssignResult | null>(null);
  const already = useMemo(() => new Set(alreadyAssigned ?? []), [alreadyAssigned]);

  useEffect(() => {
    fetch("/api/admin/tests?list=1")
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.data) ? j.data : [];
        setTests(
          list.map((t: { id: string; test_name: string; status: string | null; modules?: { section?: string } | { section?: string }[] | null }) => ({
            id: t.id,
            name: t.test_name,
            status: t.status,
            section: Array.isArray(t.modules) ? t.modules[0]?.section ?? null : (t.modules as { section?: string } | null)?.section ?? null,
          })),
        );
      })
      .catch(() => setFetchError("Failed to load tests"));
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = (tests ?? []).filter((t) => !q || t.name.toLowerCase().includes(q));
  const pickedIds = new Set(picked.map((t) => t.id));
  const draftCount = picked.filter((t) => t.status === "Draft").length;
  const publishIso = draftCount > 0 ? nyLocalToIso(publishLocal) : null;
  const publishInvalid = draftCount > 0 && publishLocal !== "" && !publishIso;

  function toggle(t: PickTest) {
    setPicked((prev) => (prev.some((p) => p.id === t.id) ? prev.filter((p) => p.id !== t.id) : [...prev, t]));
  }

  async function submit() {
    if (picked.length === 0 || submitting || publishInvalid) return;
    setSubmitting(true);
    setError(null);
    try {
      setResult(await postBulkAssign({ testIds: picked.map((t) => t.id), studentIds, publishAt: publishIso }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const who = studentIds.length === 1 ? studentNames[0] : `${studentIds.length} students`;

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
        <div role="dialog" aria-modal="true" aria-label="Assign tests" className="bg-surface border border-divider rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[85vh]">
          <div className="flex items-center justify-between p-5 border-b border-divider">
            <div className="min-w-0">
              <h2 className="font-bold text-charcoal text-lg flex items-center gap-2">
                <ClipboardList size={16} />
                Assign tests
              </h2>
              <p className="text-soft-mute text-xs mt-0.5 truncate">{who}</p>
            </div>
            <button onClick={result ? onDone : onClose} className="text-soft-mute hover:text-charcoal" aria-label="Close">
              <X size={20} />
            </button>
          </div>

          {result ? (
            <div className="p-5">
              <BulkAssignResultView result={result} />
            </div>
          ) : (
            <>
              {picked.length > 0 && (
                <div className="px-4 pt-3">
                  <p className="text-xs font-semibold text-charcoal mb-1.5">Selected ({picked.length})</p>
                  <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                    {picked.map((t) => (
                      <span key={t.id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-warm-coral/15 px-2.5 py-1 text-xs text-charcoal">
                        <span className="truncate">{t.name}</span>
                        {t.status === "Draft" && <span className="text-soft-mute">· Draft</span>}
                        <button type="button" onClick={() => toggle(t)} aria-label={`Remove ${t.name}`} className="text-soft-mute hover:text-charcoal">
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="p-3 border-b border-divider">
                <div className="relative">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-soft-mute" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search tests…"
                    autoFocus
                    className="w-full pl-9 pr-3 py-2 bg-light-bg border border-divider rounded-xl text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-coral/50"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-0.5 min-h-[10rem]">
                {tests === null && !fetchError && <p className="text-center text-soft-mute text-sm py-6">Loading…</p>}
                {fetchError && <p className="text-center text-status-error text-sm py-6">{fetchError}</p>}
                {tests !== null &&
                  filtered.map((t) => {
                    const closed = t.status === "Closed";
                    const has = already.has(t.id);
                    const disabled = closed || has;
                    const on = pickedIds.has(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        disabled={disabled}
                        onClick={() => toggle(t)}
                        title={closed ? "Closed tests can't be assigned. Reopen it first." : undefined}
                        className={clsx(
                          "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors",
                          disabled ? "opacity-50 cursor-not-allowed" : on ? "bg-warm-coral/15 text-charcoal" : "hover:bg-light-bg text-charcoal",
                        )}
                      >
                        <span
                          className={clsx(
                            "shrink-0 w-4 h-4 rounded border flex items-center justify-center",
                            on ? "bg-warm-coral border-warm-coral" : "border-divider",
                          )}
                        >
                          {on && <Check size={11} className="text-white" />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{t.name}</div>
                          {(t.status || t.section) && (
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-soft-mute">
                              <SubjectTag section={t.section} />
                              {t.status && <span>{t.status}</span>}
                            </div>
                          )}
                        </div>
                        {has && <span className="text-xs text-soft-mute italic shrink-0">already assigned</span>}
                      </button>
                    );
                  })}
                {tests !== null && filtered.length === 0 && (
                  <p className="text-center text-soft-mute text-sm py-6">{tests.length === 0 ? "No tests." : "No tests match."}</p>
                )}
              </div>
              {draftCount > 0 && (
                <div className="px-4 pt-3">
                  <PublishAtField draftCount={draftCount} value={publishLocal} onChange={setPublishLocal} />
                </div>
              )}
            </>
          )}

          <div className="p-5 border-t border-divider flex items-center justify-between gap-3">
            <span className="text-xs min-w-0">
              {error && <span className="text-status-error">{error}</span>}
              {!error && publishInvalid && <span className="text-status-error">Enter a full date and time</span>}
            </span>
            <div className="flex gap-2 shrink-0">
              {result ? (
                <button onClick={onDone} className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors">
                  Done
                </button>
              ) : (
                <>
                  <button onClick={onClose} className="px-4 py-2 rounded-xl border border-divider text-mid-gray text-sm transition-colors hover:text-charcoal">
                    Cancel
                  </button>
                  <button
                    onClick={submit}
                    disabled={picked.length === 0 || submitting || publishInvalid}
                    className="px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm disabled:opacity-50 transition-colors"
                  >
                    {submitting ? "Assigning…" : `Assign ${plural(picked.length, "test")}`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}
