"use client";

// The "…" menu of one row on the admin test page's Students table and on
// its Submissions page (ticket 969e0414): the actions that fit the
// attempt's state, each behind a dialog that says exactly what is kept and
// what is lost. Same APIs as Manage submissions / Grant retake / Remove:
//   force submit   POST   /api/admin/submissions/[id]/force-submit
//   reset module   POST   /api/admin/submissions/[id]/reset
//   reopen M2      POST   /api/admin/submissions/[id]/reopen-module-2
//   delete         DELETE /api/admin/submissions/[id]  (a full-length row deletes the whole attempt)
//   grant retake   POST   /api/admin/tests/[id]/grant-retake
//   remove         RemoveStudentDialog (/api/admin/tests/[id]/remove-students)

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { clsx } from "clsx";
import { RefreshCw, RotateCcw, Send, SlidersHorizontal, Trash2, Undo2, UserMinus } from "lucide-react";
import { RowActionsMenu, RowMenuSlot, type RowAction } from "@/components/ui/data-table";
import { Dialog, cancelBtn, primaryBtn } from "../TestStatusActions";
import RemoveStudentDialog from "./RemoveStudentDialog";
import { formatDateTime } from "@/lib/datetime";
import {
  moduleSummary,
  reopenedModule2ClosesAt,
  type AttemptFacts,
  type AttemptModuleFacts,
} from "@/lib/attempt-actions";

const dangerBtn =
  "px-4 py-2 rounded-xl bg-status-error hover:bg-status-error/90 text-white font-semibold text-sm transition-colors disabled:opacity-40";

function P({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return <p className={clsx("text-sm", strong ? "text-charcoal font-medium" : "text-mid-gray")}>{children}</p>;
}

export interface AttemptActionsMenuProps {
  testId: string;
  studentId: string;
  studentName: string;
  /** The attempt this row shows; null = assigned, not started. */
  attempt: AttemptFacts | null;
  /** The student's latest attempt (only that one can be reopened). */
  isLatest: boolean;
  /** Full-length SAT: delete / retake / remove only; module actions live on Manage submissions. */
  fullLength?: boolean;
  dueDate: string | null;
  retakePending: boolean;
  /** Individually assigned: "Remove from this test…" (null = not individually assigned). */
  remove: { submissionCount: number; hasGradedSubmission: boolean; visibleViaGroup: boolean } | null;
  /** Assigned only through these classes (no per-student removal possible). */
  classOnly?: string[];
  /** Full-length SAT: the attempt in words for the dialogs ("Total 1210 · R&W 600 · Math 610"). */
  fullLengthSummary?: string;
}

type Open =
  | { kind: "force" }
  | { kind: "resetOpen" }
  | { kind: "resetPick" }
  | { kind: "reopen" }
  | { kind: "retake" }
  | { kind: "delete" }
  | { kind: "remove" };

export default function AttemptActionsMenu(props: AttemptActionsMenuProps) {
  const { testId, studentId, studentName: name, attempt, isLatest, fullLength = false, dueDate, retakePending, remove, classOnly, fullLengthSummary } = props;
  const t = useTranslations("attemptActions");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<1 | 2>(1);

  const m1 = attempt?.modules.find((m) => m.number === 1) ?? null;
  const m2 = attempt?.modules.find((m) => m.number === 2) ?? null;
  const two = Boolean(attempt?.twoModules);
  const openRow = attempt?.modules.find((m) => m.status === "In progress") ?? null;
  const closed = attempt?.state === "finished" || attempt?.state === "incomplete";

  const label = (m: AttemptModuleFacts) =>
    m.number === 1 ? t("module1") : m.track ? t("module2Track", { track: m.track }) : t("module2");
  const summary = (m: AttemptModuleFacts) => {
    const s = moduleSummary(m);
    const l = label(m);
    if (s.kind === "score") return t("sumScore", { label: l, score: s.score ?? "" });
    if (s.kind === "notTaken") return t("sumNotTaken", { label: l });
    if (s.kind === "notOpened") return t("sumNotOpened", { label: l });
    return t("sumOpen", { label: l, answered: s.answered ?? 0 });
  };
  const allSummary = () =>
    fullLength ? fullLengthSummary ?? "" : attempt ? attempt.modules.map(summary).join(" · ") : "";

  function close() {
    if (busy) return;
    setOpen(null);
    setError(null);
  }

  async function run(path: string, method: "POST" | "DELETE", body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(t("failed", { error: j.error ?? `HTTP ${res.status}` }));
        return;
      }
      setOpen(null);
      startTransition(() => router.refresh());
    } catch {
      setError(t("networkError"));
    } finally {
      setBusy(false);
    }
  }

  // ── menu ────────────────────────────────────────────────────────────────
  const items: (RowAction | false | null)[] = [];
  if (attempt && fullLength) {
    items.push(
      closed && (retakePending
        ? { label: t("retakeGranted"), icon: <RefreshCw size={14} />, disabled: true }
        : { label: t("grantRetake"), icon: <RefreshCw size={14} />, onSelect: () => setOpen({ kind: "retake" }) }),
      { label: t("manageModules"), icon: <SlidersHorizontal size={14} />, href: `/admin/tests/${testId}/manage-submissions` },
      { label: t("deleteAttempt"), icon: <Trash2 size={14} />, tone: "danger", onSelect: () => setOpen({ kind: "delete" }) },
    );
  } else if (attempt?.state === "in_progress") {
    // Resets only on the latest attempt: resetting an older one would bring
    // it back (started now) in front of the newer result (the reset route
    // refuses it too).
    items.push(
      openRow && { label: t("forceSubmit"), icon: <Send size={14} />, onSelect: () => setOpen({ kind: "force" }) },
      !isLatest
        ? null
        : openRow
        ? { label: t("resetThisModule"), icon: <RotateCcw size={14} />, onSelect: () => setOpen({ kind: "resetOpen" }) }
        : m1 && { label: t("resetAModule"), icon: <RotateCcw size={14} />, onSelect: () => { setPick(1); setOpen({ kind: "resetPick" }); } },
      { label: t("deleteAttempt"), icon: <Trash2 size={14} />, tone: "danger", onSelect: () => setOpen({ kind: "delete" }) },
    );
  } else if (attempt && closed) {
    items.push(
      two && m2 && isLatest && { label: t("reopenM2"), icon: <Undo2 size={14} />, onSelect: () => setOpen({ kind: "reopen" }) },
      retakePending
        ? { label: t("retakeGranted"), icon: <RefreshCw size={14} />, disabled: true }
        : { label: t("grantRetake"), icon: <RefreshCw size={14} />, onSelect: () => setOpen({ kind: "retake" }) },
      // Older attempts: Grant retake + Delete only (see above).
      isLatest && {
        label: two && m2 ? t("resetAModule") : t("resetThisModule"),
        icon: <RotateCcw size={14} />,
        onSelect: () => {
          setPick(1);
          setOpen({ kind: "resetPick" });
        },
      },
      { label: t("deleteAttempt"), icon: <Trash2 size={14} />, tone: "danger", onSelect: () => setOpen({ kind: "delete" }) },
    );
  }
  if (remove) {
    items.push({ label: t("removeFromTest"), icon: <UserMinus size={14} />, tone: "danger", onSelect: () => setOpen({ kind: "remove" }) });
  } else if (!attempt && classOnly && classOnly.length > 0) {
    items.push({ label: t("classOnly", { classes: classOnly.join(", ") }), icon: <UserMinus size={14} />, disabled: true });
  }

  const shown = items.filter(Boolean);
  // Keep the column aligned when a row has nothing to offer.
  if (shown.length === 0) return <RowMenuSlot />;

  // ── dialogs ─────────────────────────────────────────────────────────────
  let dialog: ReactNode = null;
  const footer = (confirmLabel: string, onConfirm: () => void, danger = false, disabled = false) => (
    <>
      {error && <span className="mr-auto text-xs text-status-error" role="alert">{error}</span>}
      <button type="button" onClick={close} className={cancelBtn} disabled={busy}>
        {t("cancel")}
      </button>
      <button type="button" onClick={onConfirm} disabled={busy || disabled} className={danger ? dangerBtn : primaryBtn} data-autofocus>
        {busy ? t("working") : confirmLabel}
      </button>
    </>
  );
  // Reopen texts, shared by "Reopen Module 2…" and "Reset a module… → Module 2".
  const reopenLines = () => {
    if (!m1 || !m2) return null;
    const closesAt = reopenedModule2ClosesAt(dueDate);
    return (
      <>
        <P strong>{t("kept", { module: summary(m1) })}</P>
        <P>{t("reopenBody", { module: summary(m2), name })}</P>
        {m2.track && <P>{t("reopenTrack", { name, track: m2.track })}</P>}
        <P>{closesAt ? t("reopenClosesAt", { name, when: formatDateTime(closesAt.toISOString()) }) : t("reopenNoDue", { name })}</P>
      </>
    );
  };

  if (open?.kind === "force" && openRow) {
    const m2Unopened = openRow.number === 2 && !openRow.opened && openRow.answered === 0;
    dialog = (
      <Dialog title={t("forceSubmitTitle", { name, label: label(openRow) })} icon={<Send size={20} className="text-warm-coral-text" />} onClose={close}
        footer={footer(t("confirmForceSubmit"), () => run(`/api/admin/submissions/${openRow.id}/force-submit`, "POST"))}>
        {openRow.number === 2 && m1 && <P strong>{t("kept", { module: summary(m1) })}</P>}
        <P>
          {openRow.number === 1
            ? two
              ? t("forceSubmitM1", { label: label(openRow), answered: openRow.answered, name })
              : t("forceSubmitSingle", { answered: openRow.answered })
            : m2Unopened
              ? t("forceSubmitM2Unopened", { name })
              : t("forceSubmitM2", { answered: openRow.answered })}
        </P>
      </Dialog>
    );
  } else if (open?.kind === "resetOpen" && openRow) {
    dialog = (
      <Dialog title={t("resetTitle", { name, label: label(openRow) })} icon={<RotateCcw size={20} className="text-warm-coral-text" />} onClose={close}
        footer={footer(t("confirmReset"), () => run(`/api/admin/submissions/${openRow.id}/reset`, "POST"), true)}>
        {openRow.number === 2 && m1 && <P strong>{t("kept", { module: summary(m1) })}</P>}
        <P>
          {openRow.number === 2
            ? t("resetOpenM2", { answered: openRow.answered, name })
            : two
              ? t("resetOpenM1", { answered: openRow.answered })
              : t("resetOpenSingle", { answered: openRow.answered })}
        </P>
        <P>{t("cantUndo")}</P>
      </Dialog>
    );
  } else if (open?.kind === "resetPick" && m1) {
    // Module 2 can be picked on a closed, latest attempt: that reset is the
    // reopen (same route), so the Module 1 result is safe.
    const canPickM2 = Boolean(closed && two && m2 && isLatest);
    const which = canPickM2 ? pick : 1;
    const target = which === 2 && m2 ? m2 : m1;
    dialog = (
      <Dialog title={t("resetTitle", { name, label: label(target) })} icon={<RotateCcw size={20} className="text-warm-coral-text" />} onClose={close}
        footer={footer(
          which === 2 ? t("confirmReopen") : t("confirmReset"),
          () =>
            which === 2 && m2
              ? run(`/api/admin/submissions/${m2.id}/reopen-module-2`, "POST")
              : run(`/api/admin/submissions/${m1.id}/reset`, "POST"),
          which === 1,
        )}>
        {canPickM2 && m2 && (
          <fieldset className="space-y-1.5">
            <legend className="text-xs text-soft-mute mb-1">{t("resetPick")}</legend>
            {([1, 2] as const).map((n) => (
              <label key={n} className="flex items-start gap-2 text-sm text-charcoal cursor-pointer">
                <input type="radio" name="reset-module" className="mt-1" checked={pick === n} onChange={() => setPick(n)} />
                <span>{n === 1 ? t("resetPickM1", { module: summary(m1) }) : t("resetPickM2", { module: summary(m2) })}</span>
              </label>
            ))}
          </fieldset>
        )}
        {which === 2 ? (
          reopenLines()
        ) : two ? (
          <>
            <P strong>{t("resetM1Finished", { modules: allSummary() })}</P>
            <P>{t("resetM1Timer", { name })}</P>
            <P>{t("cantUndo")}</P>
          </>
        ) : (
          <>
            <P strong>{t("resetSingleFinished", { score: m1.correct != null ? `${m1.correct}/${m1.total ?? 0}` : "" })}</P>
            <P>{t("resetSingleTimer", { name })}</P>
            <P>{t("cantUndo")}</P>
          </>
        )}
      </Dialog>
    );
  } else if (open?.kind === "reopen" && m2) {
    dialog = (
      <Dialog title={t("reopenTitle", { name })} icon={<Undo2 size={20} className="text-warm-coral-text" />} onClose={close}
        footer={footer(t("confirmReopen"), () => run(`/api/admin/submissions/${m2.id}/reopen-module-2`, "POST"))}>
        {reopenLines()}
      </Dialog>
    );
  } else if (open?.kind === "retake" && attempt) {
    dialog = (
      <Dialog title={t("retakeTitle", { name })} icon={<RefreshCw size={20} className="text-warm-coral-text" />} onClose={close}
        footer={footer(t("confirmRetake"), () => run(`/api/admin/tests/${testId}/grant-retake`, "POST", { studentId }))}>
        <P>
          {two && !fullLength
            ? t("retakeBody", { n: attempt.attemptNumber, summary: allSummary(), name })
            : t("retakeBodySingle", { n: attempt.attemptNumber, summary: allSummary(), name })}
        </P>
      </Dialog>
    );
  } else if (open?.kind === "delete" && attempt) {
    dialog = (
      <Dialog title={t("deleteTitle", { name })} icon={<Trash2 size={20} className="text-status-error" />} onClose={close}
        footer={footer(
          t("confirmDelete"),
          async () => {
            // A full-length row deletes the whole attempt server-side; a
            // section test's attempt is its rows, one call each.
            const ids = fullLength ? attempt.rowIds.slice(0, 1) : attempt.rowIds;
            setBusy(true);
            setError(null);
            try {
              for (const id of ids) {
                const res = await fetch(`/api/admin/submissions/${id}`, { method: "DELETE" });
                if (!res.ok && res.status !== 404) {
                  const j = (await res.json().catch(() => ({}))) as { error?: string };
                  setError(t("failed", { error: j.error ?? `HTTP ${res.status}` }));
                  return;
                }
              }
              setOpen(null);
              startTransition(() => router.refresh());
            } catch {
              setError(t("networkError"));
            } finally {
              setBusy(false);
            }
          },
          true,
        )}>
        <P strong>
          {fullLength ? t("deleteFullLength") : t("deleteBody", { n: attempt.attemptNumber, summary: allSummary(), name })}
        </P>
        <P>{t("cantUndo")}</P>
      </Dialog>
    );
  } else if (open?.kind === "remove" && remove) {
    dialog = (
      <RemoveStudentDialog
        testId={testId}
        studentId={studentId}
        studentName={name}
        submissionCount={remove.submissionCount}
        hasGradedSubmission={remove.hasGradedSubmission}
        visibleViaGroup={remove.visibleViaGroup}
        onClose={() => setOpen(null)}
      />
    );
  }

  return (
    <>
      <RowActionsMenu label={t("menuLabel", { name })} items={shown} />
      {dialog}
    </>
  );
}
