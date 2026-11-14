"use client";

import { useEffect, useState } from "react";
import { Check, Search, UserPlus } from "lucide-react";
import { clsx } from "clsx";
import { nyLocalToIso, plural } from "@/lib/test-assign-shared";
import { Dialog, cancelBtn, primaryBtn, type BulkRow } from "./TestStatusActions";
import PublishAtField from "./PublishAtField";
import BulkAssignResultView, { postBulkAssign, type BulkAssignResult } from "./BulkAssignResult";

type Tab = "students" | "classes" | "teachers";
interface Pick {
  id: string;
  label: string;
  sub?: string;
}

// Tests list bulk bar → "Assign…" (ticket b271dd38): the single-test Assign
// dialog's three tabs (Students / Classes / Teachers, same pickers and
// QA-scoped lists), opened once for every checked test. Unlike the
// single-test tabs, nothing is removed: picks are added to each test, pairs
// already there are skipped, Closed tests are left out. One request to
// /api/admin/tests/bulk-assign; its summary is shown at the end.
export default function BulkAssignDialog({
  rows,
  allClassGroups,
  allTeachers,
  onClose,
  onDone,
}: {
  rows: BulkRow[];
  allClassGroups: { id: string; name: string; campus: string | null; grade: string | null }[];
  allTeachers: { id: string; display_name: string | null; email: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [tab, setTab] = useState<Tab>("students");
  const [search, setSearch] = useState("");
  const [students, setStudents] = useState<Pick[] | null>(null);
  const [picks, setPicks] = useState<Record<Tab, Pick[]>>({ students: [], classes: [], teachers: [] });
  const [publishLocal, setPublishLocal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkAssignResult | null>(null);

  const closed = rows.filter((r) => r.status === "Closed");
  const open = rows.filter((r) => r.status !== "Closed");
  const draftCount = open.filter((r) => r.status === "Draft").length;
  const publishIso = draftCount > 0 ? nyLocalToIso(publishLocal) : null;
  const publishInvalid = draftCount > 0 && publishLocal !== "" && !publishIso;
  const pickCount = picks.students.length + picks.classes.length + picks.teachers.length;

  // Students: server search (same route as the single-test Students tab).
  useEffect(() => {
    if (tab !== "students") return;
    const ctl = new AbortController();
    setStudents(null);
    fetch(`/api/admin/students?q=${encodeURIComponent(search)}`, { signal: ctl.signal })
      .then((r) => r.json())
      .then((j) =>
        setStudents(
          ((j.data ?? []) as { id: string; email: string; display_name: string | null }[]).map((s) => ({
            id: s.id,
            label: s.display_name ?? s.email,
            sub: s.email,
          })),
        ),
      )
      .catch(() => {});
    return () => ctl.abort();
  }, [tab, search]);

  const q = search.trim().toLowerCase();
  const match = (p: Pick) => !q || p.label.toLowerCase().includes(q) || (p.sub ?? "").toLowerCase().includes(q);
  const options: Pick[] | null =
    tab === "students"
      ? students
      : tab === "classes"
        ? allClassGroups
            .map((c) => ({ id: c.id, label: c.name, sub: [c.campus, c.grade].filter(Boolean).join(" · ") || undefined }))
            .filter(match)
        : allTeachers.map((t) => ({ id: t.id, label: t.display_name ?? t.email, sub: t.email })).filter(match);

  function toggle(p: Pick, which: Tab = tab) {
    setPicks((prev) => {
      const list = prev[which];
      return { ...prev, [which]: list.some((x) => x.id === p.id) ? list.filter((x) => x.id !== p.id) : [...list, p] };
    });
  }

  async function submit() {
    if (open.length === 0 || pickCount === 0 || submitting || publishInvalid) return;
    setSubmitting(true);
    setError(null);
    try {
      setResult(
        await postBulkAssign({
          testIds: rows.map((r) => r.id), // Closed ones come back as refused, counted in the summary
          studentIds: picks.students.map((p) => p.id),
          classGroupIds: picks.classes.map((p) => p.id),
          teacherIds: picks.teachers.map((p) => p.id),
          publishAt: publishIso,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "students", label: "Students" },
    { key: "classes", label: "Classes" },
    { key: "teachers", label: "Teachers" },
  ];
  const pickedIds = new Set(picks[tab].map((p) => p.id));

  return (
    <Dialog
      title={result ? "Assigned" : `Assign ${plural(open.length, "test")}`}
      icon={<UserPlus size={20} className="text-warm-coral-text" />}
      onClose={result ? onDone : onClose}
      footer={
        result ? (
          <button type="button" data-autofocus onClick={onDone} className={primaryBtn}>
            Done
          </button>
        ) : (
          <>
            {error && <span className="mr-auto text-xs text-status-error">{error}</span>}
            {!error && publishInvalid && <span className="mr-auto text-xs text-status-error">Enter a full date and time</span>}
            <button type="button" onClick={onClose} className={cancelBtn}>
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={open.length === 0 || pickCount === 0 || submitting || publishInvalid}
              className={primaryBtn}
            >
              {submitting ? "Assigning…" : `Assign ${plural(open.length, "test")}`}
            </button>
          </>
        )
      }
    >
      {result ? (
        <BulkAssignResultView result={result} />
      ) : (
        <>
          <p className="text-xs text-soft-mute">
            {open.map((r) => r.name).slice(0, 4).join(", ")}
            {open.length > 4 ? `, +${open.length - 4} more` : ""}
          </p>
          {closed.length > 0 && (
            <p className="text-xs text-status-warning">
              {plural(closed.length, "Closed test")} left out (reopen first): {closed.map((r) => r.name).join(", ")}
            </p>
          )}

          {pickCount > 0 && (
            <div>
              <p className="text-xs font-semibold text-charcoal mb-1.5">Selected ({pickCount})</p>
              <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                {(["students", "classes", "teachers"] as Tab[]).flatMap((k) =>
                  picks[k].map((p) => (
                    <button
                      key={`${k}-${p.id}`}
                      type="button"
                      onClick={() => toggle(p, k)}
                      aria-label={`Remove ${p.label}`}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-warm-coral/15 px-2.5 py-1 text-xs text-charcoal hover:bg-warm-coral/25"
                    >
                      <span className="truncate">{p.label}</span>
                      <span className="text-soft-mute">· {k === "students" ? "student" : k === "classes" ? "class" : "teacher"} ×</span>
                    </button>
                  )),
                )}
              </div>
            </div>
          )}

          <div className="flex gap-1 border-b border-divider" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => {
                  setTab(t.key);
                  setSearch("");
                }}
                className={clsx(
                  "px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors",
                  tab === t.key ? "border-warm-coral text-charcoal" : "border-transparent text-soft-mute hover:text-charcoal",
                )}
              >
                {t.label}
                {picks[t.key].length > 0 && <span className="ml-1 text-xs text-warm-coral-text">{picks[t.key].length}</span>}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-soft-mute" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${tab}…`}
              className="w-full pl-9 pr-3 py-2 bg-light-bg border border-divider rounded-xl text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-coral/50"
            />
          </div>
          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {options === null ? (
              <p className="text-center text-soft-mute text-sm py-6">Loading…</p>
            ) : options.length === 0 ? (
              <p className="text-center text-soft-mute text-sm py-6">Nothing matches.</p>
            ) : (
              options.map((p) => {
                const on = pickedIds.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(p)}
                    className={clsx(
                      "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors",
                      on ? "bg-warm-coral/15 text-charcoal" : "hover:bg-light-bg text-charcoal",
                    )}
                  >
                    <span className={clsx("shrink-0 w-4 h-4 rounded border flex items-center justify-center", on ? "bg-warm-coral border-warm-coral" : "border-divider")}>
                      {on && <Check size={11} className="text-white" />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate">{p.label}</span>
                      {p.sub && p.sub !== p.label && <span className="block text-xs text-soft-mute truncate">{p.sub}</span>}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <p className="text-[11px] text-soft-mute">Added to each test; anyone already assigned is skipped. Nothing is removed.</p>
          <PublishAtField draftCount={draftCount} value={publishLocal} onChange={setPublishLocal} />
        </>
      )}
    </Dialog>
  );
}
