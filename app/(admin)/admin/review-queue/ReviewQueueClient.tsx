"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { DataTable, HeadRow, Th, Td, DataRow, TruncatedText, cn } from "@/components/ui/data-table";
import { Portal } from "@/components/ui/Portal";
import { StatusBadge, SubjectTag } from "@/components/ui/StatusBadge";
import MathMarkdown from "@/components/MathMarkdown";
import FigureDiff, { describeDecision, postDecision, type DecideResponse } from "@/components/questions/FigureDiff";
import type { KeyChangePreview } from "@/lib/key-check";
import {
  advanceAfterDecision,
  API_MAX_LIMIT,
  decisionKeyAllowed,
  filterParams,
  nextOpenIndex,
  progressStorageKey,
  undoBlocked,
  undoPlan,
  type DecisionRecord,
  type QueueFilters,
  type UndoPlan,
} from "@/lib/review-queue-view";
import type { GroupId, GroupSummary, QueueItem, QueuePageData } from "./types";

type Preview = KeyChangePreview & { keyChanged: boolean; stillMismatched: string | null; live: boolean };

const btnPrimary =
  "rounded-lg bg-warm-coral px-3 py-1.5 text-sm font-semibold text-white hover:bg-warm-coral-dark disabled:opacity-50";
const btn = "rounded-lg border border-divider bg-surface px-3 py-1.5 text-sm text-charcoal hover:bg-light-bg disabled:opacity-50";
const kbd = "ml-1 rounded border border-current/30 px-1 font-mono text-[10px] opacity-70";

type PageMeta = Omit<QueuePageData, "items" | "nextCursor">;

/** One decision made on this page (for the counts, the progress bar and Undo). */
interface Made {
  id: string;
  group: GroupId;
  at: number;
  record: DecisionRecord;
  item: QueueItem;
  undone?: boolean;
}

/** What the focused card does for 1 / 2 / E (set by the card itself). */
interface CardActions {
  one?: () => void;
  two?: () => void;
  edit?: () => void;
  /** Stem group: save the re-read PDF text (U, never 1: 1 is "re-read"). */
  usePdfText?: () => void;
}

async function fetchQueue(params: Record<string, string>, signal?: AbortSignal): Promise<QueuePageData & { canWrite?: boolean }> {
  const res = await fetch(`/api/admin/review-queue?${new URLSearchParams(params)}`, { signal, cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function readProgress(): Record<string, number> {
  try {
    return JSON.parse(window.sessionStorage.getItem(progressStorageKey()) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function writeProgress(p: Record<string, number>) {
  try {
    window.sessionStorage.setItem(progressStorageKey(), JSON.stringify(p));
  } catch {
    // private mode: the bar still counts for this page view
  }
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

export default function ReviewQueueClient({ initial, filters: initialFilters, canWrite }: { initial: QueuePageData; filters: QueueFilters; canWrite: boolean }) {
  const [meta, setMeta] = useState<PageMeta>(initial);
  const [items, setItems] = useState<QueueItem[]>(initial.items);
  const [nextCursor, setNextCursor] = useState<string | null>(initial.nextCursor);
  const [group, setGroup] = useState<GroupId>(initial.group);
  const [filters, setFilters] = useState<QueueFilters>(initialFilters);
  const [loading, setLoading] = useState<"switch" | "more" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Made[]>([]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"list" | "focus">("list");
  const [focusIdx, setFocusIdx] = useState(0);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [undoState, setUndoState] = useState<{ busy: boolean; msg: { text: string; ok: boolean } | null; dialog: { item: QueueItem; key: string; preview: Preview; body: Record<string, unknown> } | null }>({ busy: false, msg: null, dialog: null });
  const abortRef = useRef<AbortController | null>(null);
  const actionsRef = useRef<CardActions | null>(null);
  // Latest values for callbacks that finish later (a decision request, a key press).
  const itemsRef = useRef(items);
  const modeRef = useRef(mode);
  const focusIdxRef = useRef(focusIdx);
  const groupRef = useRef(group);
  const decidedRef = useRef<Map<string, Made>>(new Map());
  /** Every load gets a number; only the latest one's answer is used. */
  const loadSeqRef = useRef(0);
  /** When the focused card last changed (decision keys wait KEY_GUARD_MS). */
  const focusChangedAtRef = useRef(0);

  useEffect(() => setProgress(readProgress()), []);

  const current = meta.summary.find((g) => g.id === group) ?? meta.summary[0];
  const labelOf = useCallback((id: GroupId) => meta.summary.find((g) => g.id === id)?.label ?? id, [meta.summary]);
  const decided = useMemo(() => new Map(made.filter((m) => !m.undone).map((m) => [m.id, m] as const)), [made]);
  // The cached counts may predate decisions made here: take those off.
  const waitingOf = useCallback(
    (g: GroupSummary) => Math.max(0, g.waiting - made.filter((m) => !m.undone && m.group === g.id && m.at > Date.parse(meta.builtAt)).length),
    [made, meta.builtAt],
  );
  itemsRef.current = items;
  modeRef.current = mode;
  focusIdxRef.current = focusIdx;
  groupRef.current = group;
  decidedRef.current = decided;
  const focusedId = mode === "focus" ? items[Math.min(focusIdx, items.length - 1)]?.id ?? null : null;
  useEffect(() => {
    focusChangedAtRef.current = Date.now();
  }, [focusedId]);

  const load = useCallback(
    async (next: { group?: GroupId | null; filters?: QueueFilters; append?: boolean }) => {
      const g = next.group === undefined ? group : next.group;
      const f = next.filters ?? filters;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const seq = ++loadSeqRef.current;
      setLoading(next.append ? "more" : "switch");
      setError(null);
      try {
        const params: Record<string, string> = { ...filterParams(f), ...(g ? { group: g } : {}) };
        if (next.append && nextCursor) params.cursor = nextCursor;
        const data = await fetchQueue(params, ac.signal);
        // A late answer (an older load, or a page of a group left meanwhile) is dropped.
        if (ac.signal.aborted || seq !== loadSeqRef.current) return;
        if (g && data.group !== g) return;
        if (next.append && data.group !== groupRef.current) return;
        const { items: got, nextCursor: nc, ...m } = data;
        setMeta(m);
        setGroup(m.group);
        setNextCursor(nc);
        setItems((prev) => (next.append ? [...prev, ...got.filter((i) => !prev.some((p) => p.id === i.id))] : got));
        if (!next.append) {
          setFocusIdx(0);
          const qs = new URLSearchParams({ group: m.group, ...filterParams(f) });
          window.history.replaceState(null, "", `/admin/review-queue?${qs}`);
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError((e as Error).message || "Couldn't load the queue.");
      } finally {
        if (abortRef.current === ac && seq === loadSeqRef.current) setLoading(null);
      }
    },
    [group, filters, nextCursor],
  );

  const switchGroup = (g: GroupId) => {
    if (g === group && loading !== "switch") return;
    setGroup(g);
    setItems([]);
    void load({ group: g });
  };
  const changeFilters = (f: QueueFilters) => {
    setFilters(f);
    void load({ group, filters: f });
  };
  const loadMore = useCallback(() => {
    if (nextCursor && loading === null) void load({ append: true });
  }, [nextCursor, loading, load]);

  // A decision on a card: counts, progress, Undo, next card.
  const onDecided = useCallback(
    (item: QueueItem, body: Record<string, unknown>, json: DecideResponse) => {
      const record: DecisionRecord = {
        action: String(body.action),
        live: !!(json.live ?? json.key?.live),
        keyChanged: json.key?.keyChanged,
        oldKey: json.key?.oldKey ?? null,
        newKey: json.key?.newKey ?? null,
        keyAfter: json.key?.keyChanged ? json.key.newKey ?? null : item.key,
        updatedAt: json.updated_at ?? null,
      };
      setMade((m) => [...m, { id: item.id, group: item.primary, at: Date.now(), record, item }]);
      setProgress((p) => {
        const n = { ...p, [item.primary]: (p[item.primary] ?? 0) + 1 };
        writeProgress(n);
        return n;
      });
      setUndoState({ busy: false, msg: null, dialog: null });
      // Move on only if that card is still the one on screen (the request may
      // have finished after the person went elsewhere).
      if (modeRef.current === "focus") {
        const next = advanceAfterDecision(
          itemsRef.current.map((i) => i.id),
          focusIdxRef.current,
          item.id,
          new Set(decidedRef.current.keys()),
        );
        if (next !== null) setFocusIdx(next);
      }
    },
    [],
  );

  const last = [...made].reverse().find((m) => !m.undone) ?? null;
  const plan: UndoPlan | null = last ? undoPlan(last.record) : null;

  async function undo() {
    if (!last || !plan) return;
    if (plan.kind === "unskip") return;
    if (plan.kind === "none") return;
    setUndoState({ busy: true, msg: null, dialog: null });
    // Undo only what this page changed: the question must still be exactly as
    // the decision left it (same key, same updated_at). The server checks the
    // same two values again when the Undo is sent.
    let card: QueueItem | null = null;
    try {
      card = (await fetchQueue({ id: last.id })).items[0] ?? null;
    } catch {
      card = null;
    }
    const blocked = undoBlocked(last.record, card);
    if (blocked || !card) {
      setUndoState({ busy: false, msg: { text: blocked ?? "Couldn't read the question again.", ok: false }, dialog: null });
      return;
    }
    const guard = { updated_at: card.updatedAt, expected_key: card.key };
    const restoreKey = plan.kind === "set_key" ? plan.key : plan.restoreKey;
    const body: Record<string, unknown> =
      plan.kind === "set_key"
        ? { id: last.id, action: "set_key", key: plan.key, rescore: true, ...guard }
        : restoreKey !== null
          ? { id: last.id, action: "undo_live_fix", restore_key: restoreKey, rescore: true, ...guard }
          : { id: last.id, action: "undo_live_fix", ...guard };
    if (restoreKey !== null) {
      // A key goes back only after the same rescoring preview as any key change.
      try {
        const res = await fetch("/api/admin/review-queue/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: last.id, correct_answer: restoreKey }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setUndoState({ busy: false, msg: { text: json.error ?? "Couldn't load the preview.", ok: false }, dialog: null });
          return;
        }
        setUndoState({ busy: false, msg: null, dialog: { item: card, key: restoreKey, preview: json as Preview, body } });
      } catch {
        setUndoState({ busy: false, msg: { text: "Couldn't load the preview.", ok: false }, dialog: null });
      }
      return;
    }
    if (!window.confirm("Undo this change and put back the earlier version? The question stays Approved.")) {
      setUndoState({ busy: false, msg: null, dialog: null });
      return;
    }
    await sendUndo(body);
  }

  async function sendUndo(body: Record<string, unknown>) {
    if (!last) return;
    setUndoState((s) => ({ ...s, busy: true }));
    const { ok, json } = await postDecision(body);
    if (!ok) {
      setUndoState({ busy: false, msg: { text: json.error ?? "Undo didn't work.", ok: false }, dialog: null });
      return;
    }
    const id = last.id;
    setMade((m) => m.map((x) => (x === last ? { ...x, undone: true } : x)));
    setProgress((p) => {
      const n = { ...p, [last.group]: Math.max(0, (p[last.group] ?? 0) - 1) };
      writeProgress(n);
      return n;
    });
    // The card as it is now (it may be Approved, or back in another group).
    try {
      const fresh = await fetchQueue({ id });
      const card = fresh.items[0];
      if (card) setItems((list) => list.map((i) => (i.id === id ? card : i)));
    } catch {
      // the message below still says what happened
    }
    setUndoState({ busy: false, msg: { text: `Undone. ${describeDecision(json)}`, ok: true }, dialog: null });
  }

  const skip = useCallback((id: string) => {
    setSkipped((s) => new Set(s).add(id));
    const ids = itemsRef.current.map((i) => i.id);
    if (ids[focusIdxRef.current] === id) setFocusIdx(nextOpenIndex(ids, focusIdxRef.current, new Set(decidedRef.current.keys()), id));
  }, []);

  // Focus mode keys: 1 / 2 / U / E / S / ← / →. Never while typing or in a
  // dialog, never on auto-repeat; decision keys wait KEY_GUARD_MS after the
  // card changed (a key meant for the previous card doesn't land on this one).
  useEffect(() => {
    if (mode !== "focus") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
      if (isTyping(e.target) || document.querySelector('[role="dialog"]')) return;
      const k = e.key.toLowerCase();
      const a = actionsRef.current;
      const list = itemsRef.current;
      const decisionKey = ["1", "2", "u", "e", "s"].includes(k);
      if (decisionKey && !decisionKeyAllowed(e, Date.now(), focusChangedAtRef.current)) {
        e.preventDefault();
        return;
      }
      if (k === "arrowright") setFocusIdx((i) => Math.min(i + 1, Math.max(list.length - 1, 0)));
      else if (k === "arrowleft") setFocusIdx((i) => Math.max(i - 1, 0));
      else if (k === "s" && list[focusIdxRef.current]) skip(list[focusIdxRef.current].id);
      else if (k === "1" && a?.one) a.one();
      else if (k === "2" && a?.two) a.two();
      else if (k === "u" && a?.usePdfText) a.usePdfText();
      else if (k === "e" && a?.edit) a.edit();
      else if (k === "escape") setMode("list");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, skip]);

  // Focus mode: the card fills the screen.
  useEffect(() => {
    if (mode === "focus") document.querySelector('[data-testid="focus-view"]')?.scrollIntoView({ block: "start" });
  }, [mode]);

  // Focus mode: keep the next page coming before the end is reached.
  useEffect(() => {
    if (mode === "focus" && focusIdx >= items.length - 3) loadMore();
  }, [mode, focusIdx, items.length, loadMore]);

  const done = progress[group] ?? 0;
  const waitingNow = waitingOf(current);
  const groupTotal = done + waitingNow;
  const totalWaiting = Math.max(0, meta.totals.waiting - made.filter((m) => !m.undone && m.at > Date.parse(meta.builtAt) && m.item.status !== "Approved").length);
  const perModule = current.decision === "key";
  const shown = items;

  return (
    <div className="space-y-6" data-current-group={group} {...(loading === "switch" ? { "data-loading": "" } : {})}>
      <section aria-label="Summary" className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm text-charcoal">
            <strong>{totalWaiting}</strong> question{totalWaiting === 1 ? "" : "s"} waiting for a person ·{" "}
            <strong>{meta.totals.fixed}</strong> decided automatically and approved
            {meta.totals.liveFixes > 0 && (
              <>
                {" "}· <strong>{meta.totals.liveFixes}</strong> live-test change{meta.totals.liveFixes === 1 ? "" : "s"} to confirm
              </>
            )}
          </p>
          <span className={cn("text-xs", meta.spotCheck.paused ? "font-semibold text-status-error" : "text-soft-mute")}>
            {meta.spotCheck.line}
            {meta.spotCheck.paused ? " · automatic approval is paused" : ""}
          </span>
          <SettleButton canWrite={canWrite} onDone={() => void load({})} />
        </div>
        {mode === "focus" ? (
          <select aria-label="Group" className="rounded-lg border border-divider bg-surface px-2 py-1 text-sm text-charcoal" value={group} onChange={(e) => switchGroup(e.target.value as GroupId)}>
            {meta.summary
              .filter((g) => g.waiting > 0 || g.id === group)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label} ({waitingOf(g)})
                </option>
              ))}
          </select>
        ) : (
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">Reason</Th>
              <Th>Waiting</Th>
              <Th>Decided automatically</Th>
              <Th kind="long" className="w-[50%]">What to decide</Th>
            </HeadRow>
          </thead>
          <tbody>
            {meta.summary
              .filter((g) => g.waiting > 0 || g.autoFixed > 0 || g.id === group)
              .map((g) => (
                <DataRow key={g.id} tone={g.id === group ? "warning" : "default"}>
                  <Td kind="main" sticky="left">
                    <button type="button" data-group={g.id} onClick={() => switchGroup(g.id)} className={cn("text-left font-medium hover:text-warm-coral-text", g.id === group && "text-warm-coral-text")}>
                      {g.label}
                    </button>
                  </Td>
                  <Td>{waitingOf(g)}</Td>
                  <Td>{g.autoFixed || "—"}</Td>
                  <Td kind="long" className="w-[50%]">
                    <TruncatedText title={whyText(g)}>{whyText(g)}</TruncatedText>
                  </Td>
                </DataRow>
              ))}
          </tbody>
        </DataTable>
        )}
      </section>

      <Filters filters={filters} options={meta.filterOptions} onChange={changeFilters} />

      <section aria-label={current.label} className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-charcoal">
              {current.label} <span className="text-soft-mute">({waitingNow})</span>
            </h2>
            <p className="text-sm text-mid-gray">{current.ask}</p>
          </div>
          <div className="flex items-center gap-2">
            <Progress done={done} total={groupTotal} />
            {mode === "list" ? (
              <button type="button" className={btnPrimary} disabled={shown.length === 0} onClick={() => { setFocusIdx(Math.max(0, shown.findIndex((i) => !decided.has(i.id)))); setMode("focus"); }}>
                Focus mode
              </button>
            ) : (
              <button type="button" className={btn} onClick={() => setMode("list")}>
                Back to the list
              </button>
            )}
          </div>
        </div>

        {last && (
          <UndoBar
            last={last}
            plan={plan!}
            busy={undoState.busy}
            canWrite={canWrite}
            msg={undoState.msg}
            onUndo={() => (plan?.kind === "unskip" ? undefined : void undo())}
          />
        )}
        {undoState.dialog && (
          <KeyChangeDialog
            item={undoState.dialog.item}
            newKey={undoState.dialog.key}
            preview={undoState.dialog.preview}
            undo
            busy={undoState.busy}
            canWrite={canWrite}
            onCancel={() => setUndoState({ busy: false, msg: null, dialog: null })}
            onConfirm={() => void sendUndo(undoState.dialog!.body)}
          />
        )}
        {error && (
          <p role="alert" className="text-sm text-status-error">
            {error}{" "}
            <button type="button" className="underline" onClick={() => void load({})}>
              Try again
            </button>
          </p>
        )}
        {loading === "switch" && <p className="text-sm text-soft-mute">Loading…</p>}
        {loading !== "switch" && shown.length === 0 && !error && <p className="text-sm text-soft-mute">Nothing waiting here. Pick another group above.</p>}

        {mode === "focus" && shown.length > 0 ? (
          <FocusView
            items={shown}
            idx={Math.min(focusIdx, shown.length - 1)}
            total={shown.length + Math.max(0, waitingNow - shown.filter((i) => !decided.has(i.id)).length)}
            group={current}
            canWrite={canWrite}
            labelOf={labelOf}
            decided={decided}
            skipped={skipped}
            actionsRef={actionsRef}
            onDecided={onDecided}
            onPrev={() => setFocusIdx((i) => Math.max(0, i - 1))}
            onNext={() => setFocusIdx((i) => Math.min(shown.length - 1, i + 1))}
            onSkip={skip}
            loadingMore={loading === "more"}
          />
        ) : (
          loading !== "switch" && (
            <ListView
              items={shown}
              group={current}
              perModule={perModule}
              byModule={meta.byModule}
              strongByModule={meta.strongByModule}
              filters={filters}
              canWrite={canWrite}
              labelOf={labelOf}
              decided={decided}
              onDecided={onDecided}
              onBulkDone={() => void load({})}
            />
          )
        )}

        {mode === "list" && loading !== "switch" && (
          <LoadMore hasMore={!!nextCursor} loading={loading === "more"} onMore={loadMore} shown={shown.length} total={waitingNow} />
        )}
      </section>
    </div>
  );
}

function whyText(g: GroupSummary): string {
  if (g.waiting === 0) return "—";
  const also = g.alsoBlocked.slice(0, 3).map((a) => `${a.count} also: ${a.label.toLowerCase()}`);
  return [g.ask, ...also].join(" · ");
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="min-w-40 text-xs text-mid-gray" title="Decisions made in this browser tab today (not stored on the server)">
      <div className="mb-0.5" data-testid="progress-text">
        {done} / {total} done today
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-light-bg" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}>
        <div className="h-full bg-status-success" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Filters({ filters, options, onChange }: { filters: QueueFilters; options: QueuePageData["filterOptions"]; onChange: (f: QueueFilters) => void }) {
  const sel = "rounded-lg border border-divider bg-surface px-2 py-1 text-sm text-charcoal";
  const any = filters.module || filters.test !== null || filters.subject || filters.liveOnly;
  return (
    <section aria-label="Filters" className="flex flex-wrap items-center gap-2 text-sm">
      <select aria-label="Module" className={cn(sel, "max-w-72")} value={filters.module ?? ""} onChange={(e) => onChange({ ...filters, module: e.target.value || null })}>
        <option value="">All modules</option>
        {options.modules.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <select aria-label="Test number" className={sel} value={filters.test ?? ""} onChange={(e) => onChange({ ...filters, test: e.target.value ? Number(e.target.value) : null })}>
        <option value="">All test #</option>
        {options.tests.map((t) => (
          <option key={t} value={t}>
            Test #{t}
          </option>
        ))}
      </select>
      <select aria-label="Subject" className={sel} value={filters.subject ?? ""} onChange={(e) => onChange({ ...filters, subject: e.target.value || null })}>
        <option value="">All subjects</option>
        {options.subjects.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-charcoal">
        <input type="checkbox" checked={filters.liveOnly} onChange={(e) => onChange({ ...filters, liveOnly: e.target.checked })} />
        Live tests only
      </label>
      {any && (
        <button type="button" className="text-xs text-soft-mute underline hover:text-charcoal" onClick={() => onChange({ module: null, test: null, subject: null, liveOnly: false })}>
          Clear filters
        </button>
      )}
    </section>
  );
}

function UndoBar({ last, plan, busy, canWrite, msg, onUndo }: { last: Made; plan: UndoPlan; busy: boolean; canWrite: boolean; msg: { text: string; ok: boolean } | null; onUndo: () => void }) {
  if (plan.kind === "unskip") return null;
  const what = `Q${last.item.number ?? "?"} · ${last.item.moduleName}: ${ACTION_LABEL[last.record.action] ?? last.record.action}`;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-divider bg-light-bg px-3 py-2 text-sm" data-testid="undo-bar">
      <span className="text-charcoal">Last decision: {what}</span>
      <button
        type="button"
        className={btn}
        disabled={busy || !canWrite || plan.kind === "none"}
        title={plan.kind === "none" ? plan.why : plan.kind === "set_key" ? `Put the key back to ${plan.key} (shows who gets rescored first)` : "Put back the version from before this change"}
        onClick={onUndo}
      >
        {busy ? "Undoing…" : "Undo"}
      </button>
      {plan.kind === "none" && <span className="text-xs text-soft-mute">{plan.why}</span>}
      {msg && (
        <span role="status" className={msg.ok ? "text-status-success" : "text-status-error"}>
          {msg.text}
        </span>
      )}
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  set_key: "key changed",
  keep_key: "key kept",
  use_pdf: "PDF version used",
  keep_figure: "figure kept",
  use_pdf_text: "PDF text used",
  regen_explanation: "explanation rewritten",
  approve: "approved",
  confirm_live_fix: "live-test change confirmed",
  undo_live_fix: "live-test change undone",
};

function LoadMore({ hasMore, loading, onMore, shown, total }: { hasMore: boolean; loading: boolean; onMore: () => void; shown: number; total: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && onMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onMore]);
  if (!hasMore) return shown > 0 ? <p className="text-xs text-soft-mute">All {shown} shown.</p> : null;
  return (
    <div ref={ref} className="flex items-center gap-3">
      <button type="button" className={btn} disabled={loading} onClick={onMore}>
        {loading ? "Loading…" : "Load more"}
      </button>
      <span className="text-xs text-soft-mute">
        {shown} of {total} shown
      </span>
    </div>
  );
}

function ListView({
  items,
  group,
  perModule,
  byModule,
  strongByModule,
  filters,
  canWrite,
  labelOf,
  decided,
  onDecided,
  onBulkDone,
}: {
  items: QueueItem[];
  group: GroupSummary;
  perModule: boolean;
  byModule: Record<string, number>;
  strongByModule: Record<string, number>;
  filters: QueueFilters;
  canWrite: boolean;
  labelOf: (id: GroupId) => string;
  decided: Map<string, Made>;
  onDecided: (item: QueueItem, body: Record<string, unknown>, json: DecideResponse) => void;
  onBulkDone: () => void;
}) {
  const card = (item: QueueItem, i: number) => (
    <QueueCard
      key={`${item.id}-${item.updatedAt}`}
      item={item}
      decision={group.decision}
      canWrite={canWrite}
      labelOf={labelOf}
      eager={i < 2}
      done={decided.get(item.id) ?? null}
      onDecided={onDecided}
    />
  );
  if (!perModule) return <>{items.map(card)}</>;
  // Key groups: one block per module (the server orders them module by module).
  const blocks: { moduleId: string; items: QueueItem[] }[] = [];
  for (const it of items) {
    const m = it.moduleId ?? "";
    if (blocks.length && blocks[blocks.length - 1].moduleId === m) blocks[blocks.length - 1].items.push(it);
    else blocks.push({ moduleId: m, items: [it] });
  }
  let n = 0;
  return (
    <>
      {blocks.map((b) => (
        <div key={b.moduleId} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider pb-1">
            <h3 className="text-sm font-semibold text-charcoal">
              {b.items[0].moduleName} <span className="text-soft-mute">({byModule[b.moduleId] ?? b.items.length})</span>
            </h3>
            <AcceptAll moduleId={b.moduleId} moduleName={b.items[0].moduleName} group={group.id} filters={filters} count={strongByModule[b.moduleId] ?? 0} canWrite={canWrite} onDone={onBulkDone} />
          </div>
          {b.items.map((it) => card(it, n++))}
        </div>
      ))}
    </>
  );
}

function FocusView({
  items,
  idx,
  total,
  group,
  canWrite,
  labelOf,
  decided,
  skipped,
  actionsRef,
  onDecided,
  onPrev,
  onNext,
  onSkip,
  loadingMore,
}: {
  items: QueueItem[];
  idx: number;
  total: number;
  group: GroupSummary;
  canWrite: boolean;
  labelOf: (id: GroupId) => string;
  decided: Map<string, Made>;
  skipped: Set<string>;
  actionsRef: MutableRefObject<CardActions | null>;
  onDecided: (item: QueueItem, body: Record<string, unknown>, json: DecideResponse) => void;
  onPrev: () => void;
  onNext: () => void;
  onSkip: (id: string) => void;
  loadingMore: boolean;
}) {
  const cur = items[idx];
  // The previous, current and next cards stay mounted (only the current one
  // shows): the next card's math, images and PDF page are ready before → .
  const window3 = [idx - 1, idx, idx + 1].filter((i) => i >= 0 && i < items.length);
  return (
    <div className="space-y-3" data-testid="focus-view">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" className={btn} onClick={onPrev} disabled={idx === 0}>
          ← Prev
        </button>
        <span className="font-medium text-charcoal" data-testid="focus-position">
          {idx + 1} / {total}
        </span>
        <button type="button" className={btn} onClick={onNext} disabled={idx >= items.length - 1}>
          Next →
        </button>
        <button type="button" className={btn} onClick={() => onSkip(cur.id)}>
          Skip <span className={kbd}>S</span>
        </button>
        {skipped.has(cur.id) && <span className="text-xs text-soft-mute">skipped before</span>}
        {loadingMore && <span className="text-xs text-soft-mute">loading more…</span>}
        <span className="ml-auto text-xs text-soft-mute">
          Keys: <span className={kbd}>1</span> use suggestion · <span className={kbd}>2</span> keep current · <span className={kbd}>U</span> use PDF text · <span className={kbd}>E</span> edit · <span className={kbd}>S</span> skip ·{" "}
          <span className={kbd}>←</span>/<span className={kbd}>→</span> prev/next · <span className={kbd}>Esc</span> list
        </span>
      </div>
      {window3.map((i) => (
        <div key={items[i].id} hidden={i !== idx}>
          <QueueCard
            key={`${items[i].id}-${items[i].updatedAt}`}
            item={items[i]}
            decision={group.decision}
            canWrite={canWrite}
            labelOf={labelOf}
            layout="focus"
            eager
            active={i === idx}
            actionsRef={i === idx ? actionsRef : undefined}
            done={decided.get(items[i].id) ?? null}
            onDecided={onDecided}
          />
        </div>
      ))}
    </div>
  );
}

/** "Let the system settle what it can": preview the counts, then apply. */
function SettleButton({ canWrite, onDone }: { canWrite: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<{ counts: Record<string, number>; total: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function call(apply: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/review-queue/auto-settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(json.error ?? "That didn't work.");
        return;
      }
      if (!apply) setPlan({ counts: json.counts ?? {}, total: json.actionable ?? 0 });
      else {
        setPlan(null);
        setMsg(settleText(json.counts ?? {}, true));
        onDone();
      }
    } catch {
      setMsg("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!canWrite) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {plan === null ? (
        <button type="button" className={btn} disabled={busy} onClick={() => void call(false)}>
          {busy ? "Checking…" : "Let the system settle what it can"}
        </button>
      ) : (
        <>
          <span className="text-charcoal">{plan.total ? settleText(plan.counts, false) : "Nothing the system can settle right now."}</span>
          {plan.total > 0 && (
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void call(true)}>
              {busy ? "Working…" : "Go ahead"}
            </button>
          )}
          <button type="button" className={btn} disabled={busy} onClick={() => setPlan(null)}>
            Cancel
          </button>
        </>
      )}
      {msg && <span role="status" className="text-mid-gray">{msg}</span>}
    </div>
  );
}

function settleText(c: Record<string, number>, done: boolean): string {
  const parts = [
    c.approved ? `${done ? "approved" : "approve"} ${c.approved}` : null,
    c.key_set ? `${done ? "set" : "set"} ${c.key_set} key${c.key_set === 1 ? "" : "s"} where both solves agree` : null,
    c.key_set_waiting ? `${c.key_set_waiting} key${c.key_set_waiting === 1 ? "" : "s"} set but still waiting on the explanation` : null,
    c.to_queue ? `${done ? "moved" : "move"} ${c.to_queue} Draft${c.to_queue === 1 ? "" : "s"} into the queue` : null,
    c.needs_person ? `${c.needs_person} key${c.needs_person === 1 ? "" : "s"} left for you (students answered)` : null,
  ].filter(Boolean);
  return parts.length ? `${done ? "Done: " : "The system would "}${parts.join(", ")}.` : done ? "Nothing changed." : "Nothing to do.";
}

/**
 * Per module: accept every suggested key, after a list of the changes and
 * who gets rescored. The module's cards are loaded when the list opens (the
 * page only holds the cards scrolled to so far).
 */
function AcceptAll({
  moduleId,
  moduleName,
  group,
  filters,
  count,
  canWrite,
  onDone,
}: {
  moduleId: string;
  moduleName: string;
  group: GroupId;
  filters: QueueFilters;
  count: number;
  canWrite: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<QueueItem[]>([]);
  const [rows, setRows] = useState<{ item: QueueItem; preview: Preview | null; error: string | null; done?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  if (count === 0 || !canWrite || !moduleId) return null;

  async function openList() {
    setOpen(true);
    setBusy(true);
    setRows([]);
    setLoadError(null);
    let list: QueueItem[] = [];
    try {
      // The API serves at most API_MAX_LIMIT cards per call: page through the module.
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard++) {
        const data = await fetchQueue({ ...filterParams(filters), group, module: moduleId, limit: String(API_MAX_LIMIT), ...(cursor ? { cursor } : {}) });
        list.push(...data.items.filter((i) => i.suggestion?.strong && i.suggestion.answer !== i.key && !list.some((x) => x.id === i.id)));
        cursor = data.nextCursor;
        if (!cursor) break;
      }
    } catch (e) {
      setLoadError((e as Error).message);
    }
    setTargets(list);
    const out: typeof rows = [];
    for (const item of list) {
      try {
        const res = await fetch("/api/admin/review-queue/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id, correct_answer: item.suggestion!.answer }),
        });
        const json = await res.json().catch(() => ({}));
        out.push(res.ok ? { item, preview: json as Preview, error: (json as Preview).stillMismatched ? `doesn't fit: ${(json as Preview).stillMismatched}` : null } : { item, preview: null, error: json.error ?? "no preview" });
      } catch {
        out.push({ item, preview: null, error: "no preview" });
      }
      setRows([...out]);
    }
    setBusy(false);
  }

  async function applyAll() {
    setBusy(true);
    const next = [...rows];
    for (const r of next) {
      if (r.error || !r.preview) continue;
      const { ok, json } = await postDecision({ id: r.item.id, updated_at: r.item.updatedAt, action: "set_key", key: r.item.suggestion!.answer, expected_key: r.item.key, rescore: true });
      r.done = ok ? describeDecision(json) : json.error ?? "That didn't work.";
      setRows([...next]);
    }
    setBusy(false);
    onDone();
  }

  const finished = rows.length > 0 && rows.every((r) => r.done || r.error);
  return (
    <>
      <button type="button" className={btnPrimary} disabled={busy} onClick={() => void openList()}>
        Accept all {count} suggestion{count === 1 ? "" : "s"}
      </button>
      {open && (
        <Portal>
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setOpen(false)}>
            <div role="dialog" aria-modal="true" aria-label="Accept all suggestions" onClick={(e) => e.stopPropagation()} className="max-h-[85vh] w-full max-w-3xl space-y-4 overflow-y-auto rounded-2xl bg-surface p-5 shadow-xl">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-lg font-semibold text-charcoal">{moduleName}: accept {targets.length || count} suggested key{(targets.length || count) === 1 ? "" : "s"}</h2>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-md p-1 text-soft-mute hover:bg-light-bg hover:text-charcoal" disabled={busy}>
                  <X size={18} />
                </button>
              </div>
              <p className="text-sm text-mid-gray">Each key is saved with a new explanation written and checked for it. Graded answers listed here are rescored.</p>
              {loadError && <p className="text-sm text-status-error">Couldn&rsquo;t load the module&rsquo;s questions: {loadError}</p>}
              {!busy && !loadError && targets.length === 0 && <p className="text-sm text-soft-mute">No strong suggestions are left in this module.</p>}
              <div className="overflow-x-auto rounded-xl border border-divider">
                <table className="w-full text-sm" aria-label="Suggested key changes">
                  <thead className="bg-light-bg text-left text-xs text-soft-mute">
                    <tr>
                      <th className="px-3 py-2 font-medium">Question</th>
                      <th className="px-3 py-2 font-medium">Key</th>
                      <th className="px-3 py-2 font-medium">Why</th>
                      <th className="px-3 py-2 font-medium">Rescored</th>
                      <th className="px-3 py-2 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {targets.map((t) => {
                      const r = rows.find((x) => x.item.id === t.id);
                      return (
                        <tr key={t.id} className="border-t border-divider align-top">
                          <td className="px-3 py-1.5">Q{t.number ?? "?"}{t.live ? " · live test" : ""}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono">{t.key ?? "∅"} → {t.suggestion!.answer}</td>
                          <td className="px-3 py-1.5">{t.suggestion!.why}</td>
                          <td className="px-3 py-1.5">
                            {!r ? "…" : r.error ? <span className="text-status-error">{r.error}</span> : r.preview ? `${r.preview.changes.length} of ${r.preview.attempts} answer${r.preview.attempts === 1 ? "" : "s"} change${r.preview.changes.length ? `: ${[...new Set(r.preview.changes.map((c) => c.studentName))].join(", ")}` : ""}` : "—"}
                          </td>
                          <td className="px-3 py-1.5 text-xs">{r?.done ?? ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} disabled={busy} className="rounded-lg px-3 py-1.5 text-sm text-charcoal hover:bg-light-bg">
                  {finished ? "Close" : "Cancel"}
                </button>
                {!finished && targets.length > 0 && (
                  <button type="button" onClick={() => void applyAll()} disabled={busy || rows.length < targets.length} className={btnPrimary}>
                    {busy ? "Working…" : `Confirm: change ${rows.filter((r) => !r.error).length} key${rows.filter((r) => !r.error).length === 1 ? "" : "s"} and rescore`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

/** True once the element is on or near the screen (always true when `eager`). */
function useNearScreen(eager: boolean): [(el: HTMLElement | null) => void, boolean] {
  const [near, setNear] = useState(eager);
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (eager) setNear(true);
  }, [eager]);
  useEffect(() => {
    if (near || !el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near, el]);
  return [setEl, near];
}

/** Math only for cards on or near the screen; plain text until then. */
function Text({ near, children, className }: { near: boolean; children: string; className?: string }) {
  if (near) return <MathMarkdown className={className} lazyImages>{children}</MathMarkdown>;
  return <div className={cn("whitespace-pre-wrap break-words", className)}>{children}</div>;
}

function QueueCard({
  item,
  decision,
  canWrite,
  labelOf,
  layout = "list",
  eager = false,
  active = false,
  actionsRef,
  done,
  onDecided,
}: {
  item: QueueItem;
  decision: GroupSummary["decision"];
  canWrite: boolean;
  labelOf: (id: GroupId) => string;
  layout?: "list" | "focus";
  /** Render the math now (first cards, focus mode). */
  eager?: boolean;
  /** The focused card: 1 / 2 / E act on it. */
  active?: boolean;
  actionsRef?: MutableRefObject<CardActions | null>;
  /** Decided on this page already. */
  done: Made | null;
  onDecided: (item: QueueItem, body: Record<string, unknown>, json: DecideResponse) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const pdfSrc = item.hasPdf && item.moduleId && item.pageNumber ? `/api/modules/${item.moduleId}/page/${item.pageNumber}` : null;
  const focus = layout === "focus";
  // Question and PDF page side by side by default (a figure comparison has its own).
  const [showPdf, setShowPdf] = useState(focus || (!(decision === "figure" && item.proposal) && item.primary !== "live_fix"));
  const [editKey, setEditKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; data: Preview; undo?: boolean } | null>(null);
  const [reread, setReread] = useState<string | null>(null);
  const [nearRef, near] = useNearScreen(eager);
  const isLiveFix = item.primary === "live_fix" && !!item.liveFix;

  async function run(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setResult(null);
    const { ok, json } = await postDecision({ id: item.id, updated_at: item.updatedAt, ...body });
    setBusy(null);
    setResult({ text: ok ? describeDecision(json) : json.error ?? "That didn't work.", ok });
    if (ok) {
      setPreview(null);
      setEditKey(null);
      onDecided(item, body, json);
    }
  }

  /** A new key: preview who gets rescored, then confirm (never silent). */
  async function startKeyChange(key: string, undo = false) {
    const k = key.trim();
    if (!k) return;
    setBusy("preview");
    setResult(null);
    try {
      const res = await fetch("/api/admin/review-queue/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, correct_answer: k }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ text: json.error ?? "Couldn't load the preview.", ok: false });
        return;
      }
      const data = json as Preview;
      if (data.stillMismatched) {
        setResult({ text: `That key doesn't fit: ${data.stillMismatched}.`, ok: false });
        return;
      }
      if (data.attempts > 0 || data.live || undo) {
        setPreview({ key: k, data, undo });
        return;
      }
      // No graded answers: nothing to rescore.
      await run({ action: "set_key", key: k, expected_key: item.key, rescore: true }, "set_key");
    } catch {
      setResult({ text: "Couldn't load the preview.", ok: false });
    } finally {
      setBusy((b) => (b === "preview" ? null : b));
    }
  }

  async function reextract() {
    setBusy("reextract");
    setResult(null);
    try {
      const res = await fetch(`/api/admin/questions/${item.id}/reextract`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (json.ok) setReread(json.proposal.question_text as string);
      else setResult({ text: json.message ?? "Couldn't read the PDF.", ok: false });
    } catch {
      setResult({ text: "Couldn't read the PDF.", ok: false });
    } finally {
      setBusy(null);
    }
  }

  const disabled = !canWrite || busy !== null || !!done;
  const sugg = item.suggestion && item.suggestion.answer !== item.key ? item.suggestion : null;
  const pdfBlocked = !!item.proposal && (!!item.proposal.checkMarkLeak || !!item.proposal.stale);

  const keepKey = () => {
    // Keeping a key that differs from the official one overrules it.
    if (item.keyOverrulesOfficial && !window.confirm(`Keep ${item.key ?? "∅"}? This clears the official answer ${item.official} — the kept key overrules it.`)) return;
    void run({ action: "keep_key" }, "keep_key");
  };
  const openEditor = () => window.open(`/admin/questions/${item.id}`, "_blank", "noopener");

  // Focus mode shortcuts act on the same buttons (nothing new is decided here).
  const actions: CardActions = {};
  if (!disabled) {
    if (isLiveFix) actions.two = () => void run({ action: "confirm_live_fix" }, "confirm");
    else if (decision === "key") {
      if (sugg) actions.one = () => void startKeyChange(sugg.answer);
      actions.two = keepKey;
    } else if (decision === "figure") {
      if (item.proposal && !pdfBlocked) actions.one = () => void run({ action: "use_pdf" }, "use_pdf");
      actions.two = () => void run({ action: "keep_figure" }, "keep_figure");
    } else if (decision === "stem") {
      // 1 only re-reads the PDF; saving the re-read text is a separate key (U),
      // so pressing 1 twice can't replace the question text unseen.
      if (reread === null && item.hasPdf) actions.one = () => void reextract();
      if (reread !== null) actions.usePdfText = () => void run({ action: "use_pdf_text", question_text: reread }, "use_pdf_text");
    } else if (decision === "explanation") actions.one = () => void run({ action: "regen_explanation" }, "regen");
    else if (decision === "approve") actions.two = () => void run({ action: "approve" }, "approve");
  }
  actions.edit = !isLiveFix && decision === "key" && !disabled ? () => setEditKey("") : decision === "key_format" ? () => window.open("/admin/questions/key-check", "_blank", "noopener") : openEditor;
  useEffect(() => {
    if (active && actionsRef) actionsRef.current = actions;
  });

  const header = (
    <header className="flex flex-wrap items-center gap-2">
      <Link href={`/admin/questions/${item.id}`} className="font-semibold text-charcoal hover:text-warm-coral-text">
        Q{item.number ?? "?"} · {item.moduleName}
      </Link>
      <SubjectTag section={item.section} />
      <StatusBadge kind="question" status={item.status === "Approved" ? "Approved" : item.status === "Draft" ? "Draft" : "Needs Review"} />
      {item.live && <span className="rounded-full bg-status-warning/12 px-2 py-0.5 text-xs font-medium text-status-warning">In a live test</span>}
      {item.studentsAnswered > 0 && (
        <span className="rounded-full bg-status-info/10 px-2 py-0.5 text-xs font-medium text-status-info">
          {item.studentsAnswered} student{item.studentsAnswered === 1 ? "" : "s"} answered
        </span>
      )}
      {item.also.length > 0 && <span className="text-xs text-soft-mute">Also: {item.also.map(labelOf).join(", ")}</span>}
      {!item.hasPdf && <span className="text-xs text-soft-mute">Source PDF unavailable</span>}
      {done && <span className="rounded-full bg-status-success/10 px-2 py-0.5 text-xs font-medium text-status-success">Decided</span>}
    </header>
  );

  const decisionLine = (
    <>
      <p className={cn("mt-2 font-semibold text-charcoal", focus ? "text-lg" : "text-base")} data-testid="queue-headline">{item.headline}</p>
      {item.evidence.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-x-1 text-sm text-mid-gray" data-testid="queue-evidence">
          {item.evidence.map((e, i) => (
            <span key={e.label}>
              {i > 0 && <span className="text-soft-mute"> · </span>}
              {e.label}:{" "}
              <strong className={cn("font-mono", e.tone === "differ" ? "text-status-error" : e.tone === "agree" ? "text-status-success" : "text-charcoal")}>{e.value}</strong>
            </span>
          ))}
        </p>
      )}
      {decision === "key" && <p className="mt-0.5 text-xs text-soft-mute" title={item.keySource.detail}>Saved key: {item.keySource.label}</p>}
      {decision !== "key" && !isLiveFix && item.plainReasons.length > 1 && (
        <ul className="mt-1 list-disc pl-5 text-sm text-mid-gray">
          {item.plainReasons.slice(1, 4).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </>
  );

  const hint = (k: string) => (focus ? <span className={kbd}>{k}</span> : null);
  const actionRow = (
    <div className="flex flex-wrap items-center gap-2">
      {isLiveFix && (
        <>
          <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "confirm_live_fix" }, "confirm")}>
            {busy === "confirm" ? "Saving…" : "Confirm"}
            {hint("2")}
          </button>
          <button
            type="button"
            className={btn}
            disabled={disabled || !item.liveFix!.canUndo}
            title={item.liveFix!.canUndo ? "Put back the version from before this change" : "No earlier version was recorded; edit it by hand"}
            onClick={() => {
              const kb = item.liveFix!.keyBefore;
              if (kb !== null && kb !== item.key) void startKeyChange(kb, true);
              else if (window.confirm("Undo this change and put back the earlier version? The question stays Approved.")) void run({ action: "undo_live_fix" }, "undo");
            }}
          >
            {busy === "undo" ? "Undoing…" : "Undo"}
          </button>
        </>
      )}
      {!isLiveFix && decision === "key" && (
        <>
          {sugg && (
            <button type="button" className={sugg.strong ? btnPrimary : btn} disabled={disabled} onClick={() => void startKeyChange(sugg.answer)} title={`Suggested by ${sugg.why}`}>
              {busy === "preview" ? "Checking…" : `Use ${sugg.answer}`}
              {hint("1")}
            </button>
          )}
          <button type="button" className={sugg?.strong ? btn : btnPrimary} disabled={disabled} onClick={keepKey}>
            {busy === "keep_key" ? "Saving…" : `Keep ${item.key ?? "∅"}`}
            {hint("2")}
          </button>
          {editKey === null ? (
            <button type="button" className={btn} disabled={disabled} onClick={() => setEditKey("")}>
              Edit
              {hint("E")}
            </button>
          ) : (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void startKeyChange(editKey);
              }}
            >
              <input
                aria-label="New key"
                value={editKey}
                onChange={(e) => setEditKey(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setEditKey(null)}
                className="w-24 rounded-lg border border-divider px-2 py-1 font-mono text-sm"
                placeholder="New key"
                autoFocus
              />
              <button type="submit" className={btn} disabled={disabled || !editKey.trim()}>
                Set
              </button>
            </form>
          )}
        </>
      )}
      {!isLiveFix && decision === "key_format" && (
        <Link href="/admin/questions/key-check" className={btnPrimary}>
          Open answer key check
        </Link>
      )}
      {!isLiveFix && (decision === "stem" || (decision === "figure" && !item.proposal)) && (
        <button type="button" className={decision === "stem" ? btnPrimary : btn} disabled={busy !== null || !item.hasPdf || !!done} onClick={() => void reextract()}>
          {busy === "reextract" ? "Reading the PDF…" : "Re-extract"}
          {decision === "stem" && reread === null ? hint("1") : null}
        </button>
      )}
      {!isLiveFix && decision === "figure" && !item.proposal && (
        <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "keep_figure" }, "keep_figure")} title="The stored figure / table / choices match the PDF">
          {busy === "keep_figure" ? "Saving…" : "Matches the PDF"}
          {hint("2")}
        </button>
      )}
      {!isLiveFix && decision === "explanation" && (
        <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "regen_explanation" }, "regen")}>
          {busy === "regen" ? "Writing…" : "Rewrite the explanation"}
          {hint("1")}
        </button>
      )}
      {!isLiveFix && decision === "approve" && (
        <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "approve" }, "approve")}>
          {busy === "approve" ? "Approving…" : "Looks right, approve"}
          {hint("2")}
        </button>
      )}
      {(decision !== "key" || isLiveFix) && (
        <Link href={`/admin/questions/${item.id}`} className={btn} target={focus ? "_blank" : undefined}>
          Edit
          {hint("E")}
        </Link>
      )}
      {pdfSrc && !focus && (
        <button type="button" className="text-xs text-soft-mute underline hover:text-charcoal" onClick={() => setShowPdf((s) => !s)}>
          {showPdf ? "Hide PDF page" : "Show PDF page"}
        </button>
      )}
      {!canWrite && <span className="text-xs text-soft-mute">QA accounts can look but not change shared questions.</span>}
    </div>
  );

  const resultLine = result && (
    <p role="status" className={result.ok ? "text-sm text-status-success" : "text-sm text-status-error"}>
      {result.text}
    </p>
  );

  const question = (
    <>
      {!(decision === "figure" && item.proposal) && (
        <div className={cn("overflow-y-auto rounded-lg bg-light-bg p-3", focus ? "max-h-[60vh]" : "max-h-80")}>
          <Text near={near} className="text-sm">{item.stem || "(empty)"}</Text>
          {item.choices.length > 0 && (
            <ul className="mt-2 space-y-1">
              {item.choices.map((c) => (
                <li key={c.label} className="flex gap-2">
                  <span className={cn("font-semibold", c.label === item.key && "text-status-success")}>{c.label}</span>
                  <Text near={near} className="min-w-0 flex-1 text-sm">{c.text || (c.image_url ? "(graph)" : "(empty)")}</Text>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {decision === "figure" && item.proposal && (
        near ? (
          <FigureDiff
            questionId={item.id}
            updatedAt={item.updatedAt}
            proposal={item.proposal}
            canWrite={canWrite && !done}
            onDone={(text, ok) => setResult({ text, ok })}
            onDecision={(action, ok, json) => ok && onDecided(item, { action }, json)}
          />
        ) : (
          <p className="text-sm text-soft-mute">Figure comparison loads when you scroll here.</p>
        )
      )}

      {reread !== null && (
        <div className="space-y-2 rounded-xl border border-status-info/30 bg-status-info/5 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-soft-mute">Question text read again from the PDF</p>
          <div className="max-h-72 overflow-y-auto">
            <MathMarkdown className="text-sm" lazyImages>{reread}</MathMarkdown>
          </div>
          <div className="flex gap-2">
            <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "use_pdf_text", question_text: reread }, "use_pdf_text")}>
              {busy === "use_pdf_text" ? "Saving…" : "Use PDF text"}
              {hint("U")}
            </button>
            <button type="button" className={btn} onClick={() => setReread(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </>
  );

  const details = (
    <details className="text-xs text-soft-mute">
      <summary className="cursor-pointer">Details</summary>
      <p className="mt-1">Key: {item.keySource.label} — {item.keySource.detail}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono">
        {item.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
    </details>
  );

  const pdf = showPdf && pdfSrc && (near || focus) && (
    <iframe
      src={pdfSrc}
      loading={focus ? "eager" : "lazy"}
      title={`PDF page ${item.pageNumber} for Q${item.number ?? "?"}`}
      className={cn("w-full rounded-xl border border-divider bg-white", focus ? "h-[70vh]" : "h-[420px]")}
    />
  );

  return (
    <article
      ref={nearRef}
      className={cn("rounded-2xl border border-divider bg-surface p-4", done && !focus && "opacity-60")}
      data-testid="queue-card"
      data-question-id={item.id}
    >
      {header}
      {focus ? (
        <>
          {decisionLine}
          <div className="mt-3 space-y-2">
            {actionRow}
            {resultLine}
          </div>
          {isLiveFix && <LiveFixDiff fix={item.liveFix!} />}
          <div className={cn("mt-3 grid gap-4", pdf ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "")}>
            <div className="min-w-0 space-y-3">
              {question}
              {details}
            </div>
            {pdf}
          </div>
        </>
      ) : (
        <>
          {decisionLine}
          {isLiveFix && <LiveFixDiff fix={item.liveFix!} />}
          <div className={cn("mt-3 grid gap-4", pdf ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "")}>
            <div className="min-w-0 space-y-3">
              {question}
              {actionRow}
              {resultLine}
              {details}
            </div>
            {pdf}
          </div>
        </>
      )}

      {preview && (
        <KeyChangeDialog
          item={item}
          newKey={preview.key}
          preview={preview.data}
          undo={!!preview.undo}
          busy={busy === "set_key" || busy === "undo"}
          canWrite={canWrite}
          onCancel={() => setPreview(null)}
          onConfirm={() =>
            preview.undo
              ? void run({ action: "undo_live_fix", restore_key: preview.key, rescore: true }, "undo")
              : void run({ action: "set_key", key: preview.key, expected_key: item.key, rescore: true }, "set_key")
          }
        />
      )}
    </article>
  );
}

const FIELD_LABEL: Record<string, string> = {
  question_text: "Question text",
  choices: "Answer choices",
  correct_answer: "Key",
  explanation: "Explanation",
  image_urls: "Figure",
  image_alts: "Figure description",
  has_image: "Has a figure",
  question_type: "Question type",
};

/** Before / after of a live-test change. */
function LiveFixDiff({ fix }: { fix: NonNullable<QueueItem["liveFix"]> }) {
  const shown = fix.changes.filter((c) => c.field !== "image_alts" && c.field !== "has_image");
  if (shown.length === 0) {
    return <p className="mt-2 text-xs text-soft-mute">No earlier version was recorded for this change, so only the current version is shown. Confirm it, or edit by hand.</p>;
  }
  return (
    <div className="mt-3 space-y-2">
      {fix.snapshotAt && (
        <p className="text-xs text-soft-mute">
          &ldquo;Before&rdquo; is the version saved on {new Date(fix.snapshotAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}.
        </p>
      )}
      {shown.map((c) => (
        <div key={c.field} className="grid gap-2 md:grid-cols-2">
          <ValueBox title={`${FIELD_LABEL[c.field] ?? c.field} · before`} field={c.field} value={c.before} />
          <ValueBox title={`${FIELD_LABEL[c.field] ?? c.field} · now`} field={c.field} value={c.after} />
        </div>
      ))}
    </div>
  );
}

function ValueBox({ title, field, value }: { title: string; field: string; value: unknown }): ReactNode {
  const img = (u: string) => `/api/blob-image?u=${encodeURIComponent(u)}`;
  return (
    <div className="min-w-0 rounded-xl border border-divider bg-light-bg p-2">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-soft-mute">{title}</p>
      {field === "image_urls" ? (
        Array.isArray(value) && value.length ? (
          value.map((u) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={String(u)} src={img(String(u))} alt={title} loading="lazy" className="max-h-56 w-auto max-w-full rounded border border-divider bg-white" />
          ))
        ) : (
          <span className="text-sm text-soft-mute">(none)</span>
        )
      ) : field === "choices" && Array.isArray(value) ? (
        <ul className="space-y-0.5 text-sm">
          {(value as { label?: string; text?: string }[]).map((c, i) => (
            <li key={i} className="flex gap-2">
              <span className="font-semibold">{c?.label}</span>
              <MathMarkdown className="min-w-0 flex-1 text-sm" lazyImages>{c?.text || "(empty)"}</MathMarkdown>
            </li>
          ))}
        </ul>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          <MathMarkdown className="text-sm" lazyImages>{value === null || value === undefined || value === "" ? "(empty)" : String(value)}</MathMarkdown>
        </div>
      )}
    </div>
  );
}

function KeyChangeDialog({
  item,
  newKey,
  preview,
  undo,
  busy,
  canWrite,
  onCancel,
  onConfirm,
}: {
  item: QueueItem;
  newKey: string;
  preview: Preview;
  /** Undo: the key goes back (with the earlier content for a live-test change). */
  undo?: boolean;
  busy: boolean;
  canWrite: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && onCancel()}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm key change"
          onClick={(e) => e.stopPropagation()}
          className="max-h-[85vh] w-full max-w-3xl space-y-4 overflow-y-auto rounded-2xl bg-surface p-5 shadow-xl"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold text-charcoal">
              Q{item.number ?? "?"} · {undo ? "undo: put the key back" : "change the key"} {item.key ?? "∅"} → {newKey}
            </h2>
            <button type="button" onClick={onCancel} aria-label="Close" className="rounded-md p-1 text-soft-mute hover:bg-light-bg hover:text-charcoal">
              <X size={18} />
            </button>
          </div>
          {preview.live && (
            <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
              This question is in a live test. It stays Approved and gets a [live-fix] note.
            </p>
          )}
          <p className="text-sm text-charcoal">
            {preview.attempts} graded answer{preview.attempts === 1 ? "" : "s"} to this question · <strong>{preview.changes.length} would change</strong> when
            rescored. The explanation is rewritten for the new key.
          </p>
          {preview.changes.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-divider">
              <table className="w-full text-sm" aria-label="Attempts that change">
                <thead className="bg-light-bg text-left text-xs text-soft-mute">
                  <tr>
                    <th className="px-3 py-2 font-medium">Student</th>
                    <th className="px-3 py-2 font-medium">Test</th>
                    <th className="px-3 py-2 font-medium">Answer</th>
                    <th className="px-3 py-2 font-medium">Correct</th>
                    <th className="px-3 py-2 font-medium">Score (old → new)</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((c) => (
                    <tr key={c.submissionId} className="border-t border-divider">
                      <td className="px-3 py-1.5">{c.studentName}</td>
                      <td className="px-3 py-1.5">{c.testName}</td>
                      <td className="px-3 py-1.5 font-mono">{c.studentAnswer ?? "—"}</td>
                      <td className="px-3 py-1.5">{c.wasCorrect ? "right → wrong" : "wrong → right"}</td>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        {c.oldCorrect}/{c.total} → <strong>{c.newCorrect}/{c.total}</strong>
                        <span className="text-soft-mute"> · {c.oldScaled ?? "—"} → {c.newScaled}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-charcoal hover:bg-light-bg">
              Cancel
            </button>
            <button type="button" onClick={onConfirm} disabled={busy || !canWrite} className={btnPrimary}>
              {busy ? "Applying…" : `Confirm: ${undo ? "undo and" : "change the key and"} rescore ${preview.changes.length} attempt${preview.changes.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
