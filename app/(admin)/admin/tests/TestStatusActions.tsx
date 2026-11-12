"use client";

// Status actions on the Tests list (support 93e0f09e): the status badge
// opens a small menu (Draft → Publish; Published → Close / Back to draft;
// Closed → Reopen / Back to draft), and checked rows get a bulk Publish /
// Close bar. Every action confirms first and goes through the same routes
// as the test detail page, which enforce the rules server-side
// (lib/test-readiness); this file only shows them.

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ChevronDown, Lock, RotateCcw, Send, Undo2, AlertTriangle, Loader2 } from "lucide-react";
import { StatusBadge, type TestStatus } from "@/components/ui/StatusBadge";
import { Portal } from "@/components/ui/Portal";
import { cn } from "@/components/ui/data-table";
import { usePopover } from "@/components/ui/data-table/usePopover";
import { formatDateTime, formatShortDateTime } from "@/lib/datetime";
import type { ReadinessIssue, TestReadiness } from "@/lib/test-readiness";

export type StatusAction = "publish" | "close" | "reopen" | "draft";

const NEXT_STATUS: Record<StatusAction, TestStatus> = {
  publish: "Published",
  close: "Closed",
  reopen: "Published",
  draft: "Draft",
};
const ACTION_LABEL: Record<StatusAction, string> = {
  publish: "Publish",
  close: "Close",
  reopen: "Reopen",
  draft: "Back to draft",
};

async function fetchReadiness(testId: string): Promise<TestReadiness> {
  const res = await fetch(`/api/admin/tests/${testId}/readiness`, { cache: "no-store" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j.data as TestReadiness;
}

/** Runs one status change; returns null on success or the server's reason. */
export async function runStatusAction(testId: string, action: StatusAction): Promise<string | null> {
  try {
    const res = await fetch(`/api/admin/tests/${testId}/${action}`, { method: "POST" });
    if (res.ok) return null;
    const j = await res.json().catch(() => ({}));
    return j.error ?? `Failed (HTTP ${res.status})`;
  } catch {
    return "Network error";
  }
}

function IssueList({ issues, tone, inMenu = false }: { issues: ReadinessIssue[]; tone: "error" | "warning"; inMenu?: boolean }) {
  if (issues.length === 0) return null;
  return (
    <ul className={cn("space-y-1 text-xs", tone === "error" ? "text-status-error" : "text-status-warning")}>
      {issues.map((i, n) => (
        <li key={`${i.code}-${n}`} className="flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            {i.message}
            {i.href && (
              <>
                {" "}
                <Link
                  href={i.href}
                  role={inMenu ? "menuitem" : undefined}
                  tabIndex={inMenu ? -1 : undefined}
                  className="underline hover:text-charcoal focus:outline-none focus-visible:ring-2 focus-visible:ring-warm-coral/40 rounded"
                >
                  {i.code === "questions_pending" ? "Review" : "Open module"}
                </Link>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function when(v: string | null, empty: string) {
  return v ? <span title={formatDateTime(v)}>{formatShortDateTime(v)}</span> : <span className="text-soft-mute">{empty}</span>;
}

/** Who / when summary shown before publishing or reopening. */
function AccessSummary({ r }: { r: TestReadiness }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-soft-mute">Who gets access</dt>
      <dd className="text-charcoal">{r.audience}</dd>
      <dt className="text-soft-mute">Opens</dt>
      <dd className="text-charcoal">{when(r.openDate, "As soon as it's published")}</dd>
      <dt className="text-soft-mute">Due</dt>
      <dd className="text-charcoal">{when(r.dueDate, "No due date")}</dd>
    </dl>
  );
}

/** Modal shell: role=dialog, Escape closes, portalled (table-standard rule 6). */
export function Dialog({
  title,
  icon,
  onClose,
  children,
  footer,
}: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
        <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="bg-surface border border-divider rounded-2xl w-full max-w-md shadow-2xl max-h-[85vh] flex flex-col">
          <div className="p-5 border-b border-divider flex items-start gap-3">
            <span className="shrink-0 mt-0.5">{icon}</span>
            <h3 id={titleId} className="font-bold text-charcoal text-base">{title}</h3>
          </div>
          <div className="px-5 py-4 space-y-3 overflow-y-auto">{children}</div>
          <div className="p-5 border-t border-divider flex items-center justify-end gap-2">{footer}</div>
        </div>
      </div>
    </Portal>
  );
}

export const cancelBtn =
  "px-4 py-2 rounded-xl border border-divider text-mid-gray hover:text-charcoal text-sm transition-colors";
export const primaryBtn =
  "px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const dangerBtn =
  "px-4 py-2 rounded-xl bg-status-error hover:bg-status-error/90 text-white font-semibold text-sm transition-colors disabled:opacity-40";

// ── per-row status menu ───────────────────────────────────────────────────────

export function TestStatusMenu({
  testId,
  testName,
  status,
  onChanged,
}: {
  testId: string;
  testName: string;
  status: TestStatus;
  onChanged: (testId: string, status: TestStatus) => void;
}) {
  const { open, setOpen, close, anchorRef, popRef, style } = usePopover();
  const menuId = useId();
  const reasonsId = useId();
  const [readiness, setReadiness] = useState<TestReadiness | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<StatusAction | null>(null);
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Fresh readiness each time the menu opens (questions get approved meanwhile).
  useEffect(() => {
    if (!open) return;
    let live = true;
    setReadiness(null);
    setLoadError(null);
    fetchReadiness(testId)
      .then((r) => live && setReadiness(r))
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, [open, testId]);

  function items(): HTMLElement[] {
    return Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  }
  // Focus the first item on open, and again once readiness arrives unless
  // the user already moved within the menu.
  useEffect(() => {
    if (open && !popRef.current?.contains(document.activeElement)) items()[0]?.focus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, readiness]);

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === "Tab") {
      close();
    }
  }

  const publishLike = status === "Draft" ? "publish" : status === "Closed" ? "reopen" : null;
  const blocked = !readiness || !readiness.canPublish;
  const draftBlocked = !readiness || readiness.hasSubmissions;

  type Entry = { action: StatusAction; disabled: boolean; reason?: string; icon: ReactNode; danger?: boolean };
  const entries: Entry[] = [];
  if (publishLike) {
    entries.push({
      action: publishLike,
      disabled: blocked,
      icon: publishLike === "publish" ? <Send size={14} /> : <RotateCcw size={14} />,
    });
  }
  if (status === "Published") entries.push({ action: "close", disabled: false, icon: <Lock size={14} />, danger: true });
  if (status !== "Draft") {
    entries.push({
      action: "draft",
      disabled: draftBlocked,
      reason: readiness?.hasSubmissions ? "Students have started it" : undefined,
      icon: <Undo2 size={14} />,
    });
  }

  function choose(e: Entry) {
    if (e.disabled) return;
    close(true);
    setActionError(null);
    setOverride(false);
    setConfirm(e.action);
  }

  async function run() {
    if (!confirm) return;
    setBusy(true);
    setActionError(null);
    const err = await runStatusAction(testId, confirm);
    setBusy(false);
    if (err) {
      setActionError(err);
      return;
    }
    const next = NEXT_STATUS[confirm];
    setConfirm(null);
    onChanged(testId, next);
  }

  const unassigned = readiness?.warnings.some((w) => w.code === "unassigned") ?? false;
  const needsOverride = (confirm === "publish" || confirm === "reopen") && unassigned;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Status: ${status}. Change status of ${testName}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex items-center gap-0.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warm-coral/40 group"
      >
        <StatusBadge kind="test" status={status} className="group-hover:brightness-95" />
        <ChevronDown size={12} className="text-soft-mute group-hover:text-charcoal" aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={menuId}
            role="menu"
            aria-label={`Change status of ${testName}`}
            aria-describedby={reasonsId}
            style={style}
            onKeyDown={onMenuKey}
            className="z-50 w-72 overflow-hidden rounded-xl border border-divider bg-surface py-1 shadow-lg"
          >
            {entries.map((e) => (
              <button
                key={e.action}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={e.disabled || undefined}
                title={e.reason}
                onClick={() => choose(e)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none focus:bg-light-bg hover:bg-light-bg",
                  e.danger ? "text-status-error" : "text-charcoal",
                  e.disabled && "opacity-50 cursor-not-allowed",
                )}
              >
                {e.icon}
                {ACTION_LABEL[e.action]}…
                {e.reason && <span className="ml-auto text-[11px] text-soft-mute">{e.reason}</span>}
              </button>
            ))}
            <div id={reasonsId} className="px-3 pt-1 pb-2 empty:hidden" aria-live="polite">
              {!readiness && !loadError && (
                <p className="flex items-center gap-1.5 text-xs text-soft-mute">
                  <Loader2 size={12} className="animate-spin" /> Checking…
                </p>
              )}
              {loadError && <p className="text-xs text-status-error">Couldn&apos;t check this test: {loadError}</p>}
              {readiness && publishLike && (
                <div className="space-y-1 border-t border-divider pt-2">
                  <IssueList issues={readiness.blockers} tone="error" inMenu />
                  <IssueList issues={readiness.warnings} tone="warning" inMenu />
                  {readiness.canPublish && readiness.warnings.length === 0 && (
                    <p className="text-xs text-soft-mute">Ready to {publishLike}: {readiness.audience}</p>
                  )}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}

      {confirm && (readiness || confirm === "close") && (
        <Dialog
          title={
            confirm === "publish" ? "Publish this test?" : confirm === "reopen" ? "Reopen this test?" : confirm === "close" ? "Close this test?" : "Move back to Draft?"
          }
          icon={
            confirm === "close" ? <Lock size={20} className="text-status-error" /> : confirm === "draft" ? <Undo2 size={20} className="text-charcoal" /> : <Send size={20} className="text-warm-coral-text" />
          }
          onClose={() => !busy && setConfirm(null)}
          footer={
            <>
              <button type="button" onClick={() => setConfirm(null)} disabled={busy} className={cancelBtn}>
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={run}
                disabled={busy || (needsOverride && !override)}
                className={confirm === "close" ? dangerBtn : primaryBtn}
              >
                {busy ? "Working…" : ACTION_LABEL[confirm]}
              </button>
            </>
          }
        >
          <p className="text-sm text-charcoal font-medium break-words">{testName}</p>
          {(confirm === "publish" || confirm === "reopen") && readiness && (
            <>
              <AccessSummary r={readiness} />
              {needsOverride && (
                <label className="flex items-start gap-2 rounded-xl border border-status-warning/30 bg-status-warning/10 p-3 text-xs text-charcoal">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-warm-coral" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                  <span>
                    Not assigned to anyone yet, so no student will see it. {ACTION_LABEL[confirm]} anyway?
                  </span>
                </label>
              )}
            </>
          )}
          {confirm === "close" && (
            <p className="text-xs text-mid-gray leading-relaxed">
              Students can no longer start it. Anyone in the middle of it can still finish and submit, and results are
              kept. You can reopen it later.
            </p>
          )}
          {confirm === "draft" && (
            <p className="text-xs text-mid-gray leading-relaxed">
              Students won&apos;t see it until it&apos;s published again. Only possible while no student has started it.
            </p>
          )}
          {actionError && <p role="alert" className="text-status-error text-sm">{actionError}</p>}
        </Dialog>
      )}
    </>
  );
}

// ── bulk publish / close ──────────────────────────────────────────────────────

export interface BulkRow {
  id: string;
  name: string;
  status: TestStatus;
}

type BulkLine = BulkRow & {
  /** Why this test is left out (wrong status, not publishable). */
  skip?: string;
  readiness?: TestReadiness;
  /** After running: null = done, string = the server's reason. */
  result?: string | null;
};

function plural(n: number, one: string) {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/** Checked rows' action bar + one confirmation listing every test. */
export function BulkStatusBar({
  rows,
  onClear,
  onChanged,
}: {
  rows: BulkRow[];
  onClear: () => void;
  onChanged: (changes: { id: string; status: TestStatus }[]) => void;
}) {
  const [action, setAction] = useState<"publish" | "close" | null>(null);
  const [lines, setLines] = useState<BulkLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [includeUnassigned, setIncludeUnassigned] = useState(false);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [finished, setFinished] = useState(false);

  async function start(a: "publish" | "close") {
    setAction(a);
    setFinished(false);
    setIncludeUnassigned(false);
    const from: TestStatus = a === "publish" ? "Draft" : "Published";
    const base: BulkLine[] = rows.map((r) => (r.status === from ? { ...r } : { ...r, skip: `Already ${r.status}` }));
    setLines(base);
    if (a === "close") return;
    // Publish: check each Draft first (4 at a time).
    setLoading(true);
    const out = [...base];
    const todo = out.map((l, i) => ({ l, i })).filter(({ l }) => !l.skip);
    for (let k = 0; k < todo.length; k += 4) {
      await Promise.all(
        todo.slice(k, k + 4).map(async ({ l, i }) => {
          try {
            const r = await fetchReadiness(l.id);
            out[i] = { ...l, readiness: r, skip: r.canPublish ? undefined : r.blockers.map((b) => b.message).join("; ") };
          } catch (e) {
            out[i] = { ...l, skip: `Couldn't check: ${(e as Error).message}` };
          }
        }),
      );
      setLines([...out]);
    }
    setLoading(false);
  }

  const isUnassigned = (l: BulkLine) => l.readiness?.warnings.some((w) => w.code === "unassigned") ?? false;
  const runnable = lines.filter((l) => !l.skip && (action !== "publish" || includeUnassigned || !isUnassigned(l)));
  const unassignedCount = lines.filter((l) => !l.skip && isUnassigned(l)).length;

  async function run() {
    if (!action) return;
    const targets = runnable.map((l) => l.id);
    setRunning({ done: 0, total: targets.length });
    const changes: { id: string; status: TestStatus }[] = [];
    const results = new Map<string, string | null>();
    for (let i = 0; i < targets.length; i++) {
      const err = await runStatusAction(targets[i], action);
      results.set(targets[i], err);
      if (!err) changes.push({ id: targets[i], status: NEXT_STATUS[action] });
      setRunning({ done: i + 1, total: targets.length });
    }
    setLines((prev) =>
      prev.map((l) =>
        results.has(l.id) ? { ...l, result: results.get(l.id) ?? null } : l.skip ? l : { ...l, skip: "Not assigned to anyone" },
      ),
    );
    setRunning(null);
    setFinished(true);
    if (changes.length) onChanged(changes);
  }

  function closeDialog() {
    if (running) return;
    setAction(null);
    if (finished) onClear();
  }

  const doneCount = lines.filter((l) => l.result === null).length;
  const failCount = lines.filter((l) => typeof l.result === "string").length;
  const verb = action === "close" ? "Closing" : "Publishing";

  return (
    <>
      <div
        role="region"
        aria-label="Bulk actions"
        className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-divider bg-surface px-3 py-2 shadow-sm"
      >
        <span className="text-sm font-medium text-charcoal">{rows.length} selected</span>
        <button
          type="button"
          onClick={() => start("publish")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-divider px-2.5 py-1 text-xs font-medium text-charcoal hover:bg-light-bg"
        >
          <Send size={13} /> Publish…
        </button>
        <button
          type="button"
          onClick={() => start("close")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-status-error/30 px-2.5 py-1 text-xs font-medium text-status-error hover:bg-status-error/10"
        >
          <Lock size={13} /> Close…
        </button>
        <button type="button" onClick={onClear} className="ml-auto text-xs text-soft-mute hover:text-charcoal">
          Clear selection
        </button>
      </div>

      {action && (
        <Dialog
          title={
            finished
              ? `${ACTION_LABEL[action]}: ${doneCount} done${failCount ? `, ${failCount} failed` : ""}`
              : `${ACTION_LABEL[action]} ${plural(runnable.length, "test")}?`
          }
          icon={action === "close" ? <Lock size={20} className="text-status-error" /> : <Send size={20} className="text-warm-coral-text" />}
          onClose={closeDialog}
          footer={
            finished ? (
              <button type="button" autoFocus onClick={closeDialog} className={primaryBtn}>
                Done
              </button>
            ) : (
              <>
                <button type="button" onClick={closeDialog} disabled={!!running} className={cancelBtn}>
                  Cancel
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={run}
                  disabled={loading || !!running || runnable.length === 0}
                  className={action === "close" ? dangerBtn : primaryBtn}
                >
                  {running ? `${verb} ${running.done}/${running.total}…` : `${ACTION_LABEL[action]} ${runnable.length}`}
                </button>
              </>
            )
          }
        >
          {action === "close" && !finished && (
            <p className="text-xs text-mid-gray leading-relaxed">
              Students can no longer start these tests. Anyone in the middle of one can still finish and submit.
            </p>
          )}
          <ul className="divide-y divide-divider text-sm" aria-live="polite">
            {lines.map((l) => (
              <li key={l.id} className="py-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-charcoal break-words min-w-0">{l.name}</span>
                  <span className="shrink-0 text-xs">
                    {l.result === null ? (
                      <span className="text-status-success">{NEXT_STATUS[action]}</span>
                    ) : typeof l.result === "string" ? (
                      <span className="text-status-error">Failed</span>
                    ) : l.skip ? (
                      <span className="text-soft-mute">Skipped</span>
                    ) : action === "publish" && !l.readiness ? (
                      <Loader2 size={12} className="animate-spin text-soft-mute" aria-label="Checking" />
                    ) : action === "publish" && isUnassigned(l) ? (
                      <span className="text-status-warning">Not assigned</span>
                    ) : (
                      <span className="text-mid-gray">{l.readiness?.audience ?? "Ready"}</span>
                    )}
                  </span>
                </div>
                {typeof l.result === "string" && <p className="mt-0.5 text-xs text-status-error">{l.result}</p>}
                {l.result === undefined && l.skip && <p className="mt-0.5 text-xs text-soft-mute">{l.skip}</p>}
              </li>
            ))}
          </ul>
          {action === "publish" && unassignedCount > 0 && !finished && (
            <label className="flex items-start gap-2 rounded-xl border border-status-warning/30 bg-status-warning/10 p-3 text-xs text-charcoal">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-warm-coral"
                checked={includeUnassigned}
                onChange={(e) => setIncludeUnassigned(e.target.checked)}
              />
              <span>
                {plural(unassignedCount, "test")} {unassignedCount === 1 ? "isn't" : "aren't"} assigned to anyone, so no student
                will see {unassignedCount === 1 ? "it" : "them"}. Publish {unassignedCount === 1 ? "it" : "them"} anyway?
              </span>
            </label>
          )}
        </Dialog>
      )}
    </>
  );
}
