"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Check, ClipboardList, Plus, Search } from "lucide-react";
import { clsx } from "clsx";
import { Dialog, cancelBtn, primaryBtn } from "../../tests/TestStatusActions";
import { plural } from "@/lib/test-assign-shared";
import AssignTestsDialog from "../AssignTestsDialog";

export interface ClassChoice {
  id: string;
  name: string;
  meta?: string;
  alreadyIn: boolean;
  /** Tests assigned to the class (not Closed) the student doesn't have yet. */
  newTests: number;
}

// Student detail → Tests card (ticket b271dd38): "Assign test" (the same
// multi-select dialog as the Students list) and "Add to class", which says
// how many of the class's tests the student will get before confirming.
// Shown in the card header and in the empty state.
export default function StudentTestsActions({
  studentId,
  studentName,
  alreadyAssigned,
  classes,
  suspended,
  compact = false,
}: {
  studentId: string;
  studentName: string;
  alreadyAssigned: string[];
  classes: ClassChoice[];
  /** The members route refuses suspended students. */
  suspended: boolean;
  /** Smaller buttons (card header). */
  compact?: boolean;
}) {
  const t = useTranslations("studentDetail");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState<"tests" | "class" | null>(null);
  const btn = clsx(
    "inline-flex items-center gap-1.5 rounded-lg border border-divider font-medium text-charcoal hover:bg-light-bg transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
    compact ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
  );
  const done = () => {
    setOpen(null);
    startTransition(() => router.refresh());
  };

  return (
    <>
      <span className="inline-flex flex-wrap items-center justify-center gap-2">
        <button type="button" onClick={() => setOpen("tests")} className={btn}>
          <ClipboardList size={compact ? 12 : 14} />
          {t("assignTest").replace(/…$/, "")}
        </button>
        <button
          type="button"
          onClick={() => setOpen("class")}
          disabled={suspended}
          title={suspended ? "Suspended students can't be added to a class" : undefined}
          className={btn}
        >
          <Plus size={compact ? 12 : 14} />
          {t("addToClass").replace(/…$/, "")}
        </button>
      </span>
      {open === "tests" && (
        <AssignTestsDialog
          studentIds={[studentId]}
          studentNames={[studentName]}
          alreadyAssigned={alreadyAssigned}
          onClose={() => setOpen(null)}
          onDone={done}
        />
      )}
      {open === "class" && (
        <AddToClassDialog studentId={studentId} studentName={studentName} classes={classes} onClose={() => setOpen(null)} onDone={done} />
      )}
    </>
  );
}

function AddToClassDialog({
  studentId,
  studentName,
  classes,
  onClose,
  onDone,
}: {
  studentId: string;
  studentName: string;
  classes: ClassChoice[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [search, setSearch] = useState("");
  const [pick, setPick] = useState<ClassChoice | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = search.trim().toLowerCase();
  const list = classes.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.meta ?? "").toLowerCase().includes(q));

  async function confirm() {
    if (!pick || saving) return;
    setSaving(true);
    setError(null);
    try {
      // Same route as the Students list / class page "Add to class".
      const res = await fetch(`/api/admin/class-groups/${pick.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, action: "add" }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      onDone();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={`Add ${studentName} to a class`}
      icon={<Plus size={20} className="text-warm-coral-text" />}
      onClose={onClose}
      footer={
        <>
          {error && <span className="mr-auto text-xs text-status-error">{error}</span>}
          <button type="button" onClick={onClose} className={cancelBtn}>
            Cancel
          </button>
          <button type="button" onClick={confirm} disabled={!pick || saving} className={primaryBtn}>
            {saving ? "Adding…" : pick ? `Add to ${pick.name}` : "Add to class"}
          </button>
        </>
      }
    >
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-soft-mute" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search classes…"
          data-autofocus
          className="w-full pl-9 pr-3 py-2 bg-light-bg border border-divider rounded-xl text-sm text-charcoal placeholder:text-soft-mute focus:outline-none focus:border-warm-coral/50"
        />
      </div>
      <div className="max-h-64 overflow-y-auto space-y-0.5" role="radiogroup" aria-label="Class">
        {list.length === 0 ? (
          <p className="text-center text-soft-mute text-sm py-6">No classes match.</p>
        ) : (
          list.map((c) => {
            const on = pick?.id === c.id;
            return (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={c.alreadyIn}
                onClick={() => setPick(c)}
                className={clsx(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors",
                  c.alreadyIn ? "opacity-50 cursor-not-allowed" : on ? "bg-warm-coral/15 text-charcoal" : "hover:bg-light-bg text-charcoal",
                )}
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium truncate">{c.name}</span>
                  <span className="block text-xs text-soft-mute truncate">
                    {[c.meta, c.alreadyIn ? "already a member" : c.newTests > 0 ? `adds ${plural(c.newTests, "assigned test")}` : "no new tests"]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {on && <Check size={14} className="text-warm-coral shrink-0" />}
              </button>
            );
          })
        )}
      </div>
      {pick && (
        <p className="text-sm text-charcoal" role="status">
          {pick.newTests > 0
            ? `Adds ${plural(pick.newTests, "assigned test")} from ${pick.name} to ${studentName}.`
            : `${pick.name} has no tests ${studentName} doesn't already have.`}
        </p>
      )}
    </Dialog>
  );
}
