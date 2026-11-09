"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { DataTable, HeadRow, Th, Td, DataRow, TruncatedText, cn } from "@/components/ui/data-table";
import { Portal } from "@/components/ui/Portal";
import { StatusBadge, SubjectTag } from "@/components/ui/StatusBadge";
import MathMarkdown from "@/components/MathMarkdown";
import FigureDiff, { describeDecision, postDecision } from "@/components/questions/FigureDiff";
import type { KeyChangePreview } from "@/lib/key-check";
import type { GroupId, GroupSummary, QueueItem } from "./types";

type Preview = KeyChangePreview & { keyChanged: boolean; stillMismatched: string | null; live: boolean };

const btnPrimary =
  "rounded-lg bg-warm-coral px-3 py-1.5 text-sm font-semibold text-white hover:bg-warm-coral-dark disabled:opacity-50";
const btn = "rounded-lg border border-divider bg-surface px-3 py-1.5 text-sm text-charcoal hover:bg-light-bg disabled:opacity-50";

export default function ReviewQueueClient({
  summary,
  items,
  canWrite,
  initialGroup,
  spotCheck,
}: {
  summary: GroupSummary[];
  items: QueueItem[];
  canWrite: boolean;
  initialGroup?: string | null;
  spotCheck: { line: string; paused: boolean; system: number; person: number };
}) {
  const firstWaiting = summary.find((g) => g.waiting > 0)?.id ?? summary[0].id;
  const group: GroupId = (summary.find((g) => g.id === initialGroup)?.id ?? firstWaiting) as GroupId;
  const current = summary.find((g) => g.id === group)!;
  const list = items.filter((i) => i.primary === group);
  // Live-test changes are Approved already: counted on their own, not as "waiting".
  const liveFixes = items.filter((i) => i.status === "Approved").length;
  const totalWaiting = items.length - liveFixes;
  const totalFixed = summary.reduce((n, g) => n + g.autoFixed, 0);
  const labelOf = (id: GroupId) => summary.find((g) => g.id === id)?.label ?? id;
  // Key groups: one block per module, each with "Accept all suggestions".
  const byModule = new Map<string, QueueItem[]>();
  for (const i of list) byModule.set(i.moduleId ?? "", [...(byModule.get(i.moduleId ?? "") ?? []), i]);
  const perModule = current.decision === "key" && byModule.size > 0;

  return (
    <div className="space-y-6">
      <section aria-label="Summary" className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm text-charcoal">
            <strong>{totalWaiting}</strong> question{totalWaiting === 1 ? "" : "s"} waiting for a person ·{" "}
            <strong>{totalFixed}</strong> decided automatically and approved
            {liveFixes > 0 && (
              <>
                {" "}· <strong>{liveFixes}</strong> live-test change{liveFixes === 1 ? "" : "s"} to confirm
              </>
            )}
          </p>
          <span className={cn("text-xs", spotCheck.paused ? "font-semibold text-status-error" : "text-soft-mute")}>
            {spotCheck.line}
            {spotCheck.paused ? " · automatic approval is paused" : ""}
          </span>
          <SettleButton canWrite={canWrite} />
        </div>
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
            {summary
              .filter((g) => g.waiting > 0 || g.autoFixed > 0 || g.id === group)
              .map((g) => (
                <DataRow key={g.id} href={`/admin/review-queue?group=${g.id}`} tone={g.id === group ? "warning" : "default"}>
                  <Td kind="main" sticky="left">
                    <span className={cn("font-medium", g.id === group && "text-warm-coral-text")}>{g.label}</span>
                  </Td>
                  <Td>{g.waiting}</Td>
                  <Td>{g.autoFixed || "—"}</Td>
                  <Td kind="long" className="w-[50%]">
                    <TruncatedText title={whyText(g)}>{whyText(g)}</TruncatedText>
                  </Td>
                </DataRow>
              ))}
          </tbody>
        </DataTable>
      </section>

      <section aria-label={current.label} className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-charcoal">
            {current.label} <span className="text-soft-mute">({list.length})</span>
          </h2>
          <p className="text-sm text-mid-gray">{current.ask}</p>
        </div>
        {list.length === 0 && <p className="text-sm text-soft-mute">Nothing waiting here. Pick another group above.</p>}
        {perModule
          ? [...byModule.entries()].map(([moduleId, mItems]) => (
              <div key={moduleId} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider pb-1">
                  <h3 className="text-sm font-semibold text-charcoal">
                    {mItems[0].moduleName} <span className="text-soft-mute">({mItems.length})</span>
                  </h3>
                  <AcceptAll items={mItems} canWrite={canWrite} />
                </div>
                {mItems.map((item) => (
                  <QueueCard key={`${item.id}-${item.updatedAt}`} item={item} decision={current.decision} canWrite={canWrite} labelOf={labelOf} />
                ))}
              </div>
            ))
          : list.map((item) => (
              <QueueCard key={`${item.id}-${item.updatedAt}`} item={item} decision={current.decision} canWrite={canWrite} labelOf={labelOf} />
            ))}
      </section>
    </div>
  );
}

function whyText(g: GroupSummary): string {
  if (g.waiting === 0) return "—";
  const also = g.alsoBlocked.slice(0, 3).map((a) => `${a.count} also: ${a.label.toLowerCase()}`);
  return [g.ask, ...also].join(" · ");
}

/** "Let the system settle what it can": preview the counts, then apply. */
function SettleButton({ canWrite }: { canWrite: boolean }) {
  const router = useRouter();
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
        router.refresh();
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

/** Per module: accept every suggested key, after a list of the changes and who gets rescored. */
function AcceptAll({ items, canWrite }: { items: QueueItem[]; canWrite: boolean }) {
  const router = useRouter();
  const targets = items.filter((i) => i.suggestion?.strong && i.suggestion.answer !== i.key);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ item: QueueItem; preview: Preview | null; error: string | null; done?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  if (targets.length === 0 || !canWrite) return null;

  async function openList() {
    setOpen(true);
    setBusy(true);
    const out: typeof rows = [];
    for (const item of targets) {
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
    router.refresh();
  }

  const finished = rows.length > 0 && rows.every((r) => r.done || r.error);
  return (
    <>
      <button type="button" className={btnPrimary} disabled={busy} onClick={() => void openList()}>
        Accept all {targets.length} suggestion{targets.length === 1 ? "" : "s"}
      </button>
      {open && (
        <Portal>
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setOpen(false)}>
            <div role="dialog" aria-modal="true" aria-label="Accept all suggestions" onClick={(e) => e.stopPropagation()} className="max-h-[85vh] w-full max-w-3xl space-y-4 overflow-y-auto rounded-2xl bg-surface p-5 shadow-xl">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-lg font-semibold text-charcoal">{items[0].moduleName}: accept {targets.length} suggested key{targets.length === 1 ? "" : "s"}</h2>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-md p-1 text-soft-mute hover:bg-light-bg hover:text-charcoal" disabled={busy}>
                  <X size={18} />
                </button>
              </div>
              <p className="text-sm text-mid-gray">Each key is saved with a new explanation written and checked for it. Graded answers listed here are rescored.</p>
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
                {!finished && (
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

function QueueCard({
  item,
  decision,
  canWrite,
  labelOf,
}: {
  item: QueueItem;
  decision: GroupSummary["decision"];
  canWrite: boolean;
  labelOf: (id: GroupId) => string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null);
  const pdfSrc = item.hasPdf && item.moduleId && item.pageNumber ? `/api/modules/${item.moduleId}/page/${item.pageNumber}` : null;
  // Question and PDF page side by side by default (a figure comparison has its own).
  const [showPdf, setShowPdf] = useState(!(decision === "figure" && item.proposal) && item.primary !== "live_fix");
  const [editKey, setEditKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; data: Preview; undo?: boolean } | null>(null);
  const [reread, setReread] = useState<string | null>(null);
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
      router.refresh();
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

  const disabled = !canWrite || busy !== null;
  const sugg = item.suggestion && item.suggestion.answer !== item.key ? item.suggestion : null;

  return (
    <article className="rounded-2xl border border-divider bg-surface p-4" data-testid="queue-card" data-question-id={item.id}>
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
      </header>

      <p className="mt-2 text-base font-semibold text-charcoal" data-testid="queue-headline">{item.headline}</p>
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

      {isLiveFix && <LiveFixDiff fix={item.liveFix!} />}

      <div className={cn("mt-3 grid gap-4", showPdf && pdfSrc ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "")}>
        <div className="min-w-0 space-y-3">
          {!(decision === "figure" && item.proposal) && (
            <div className="max-h-80 overflow-y-auto rounded-lg bg-light-bg p-3">
              <MathMarkdown className="text-sm">{item.stem || "(empty)"}</MathMarkdown>
              {item.choices.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {item.choices.map((c) => (
                    <li key={c.label} className="flex gap-2">
                      <span className={cn("font-semibold", c.label === item.key && "text-status-success")}>{c.label}</span>
                      <MathMarkdown className="min-w-0 flex-1 text-sm">{c.text || (c.image_url ? "(graph)" : "(empty)")}</MathMarkdown>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {decision === "figure" && item.proposal && (
            <FigureDiff
              questionId={item.id}
              updatedAt={item.updatedAt}
              proposal={item.proposal}
              canWrite={canWrite}
              onDone={(text, ok) => setResult({ text, ok })}
            />
          )}

          {reread !== null && (
            <div className="space-y-2 rounded-xl border border-status-info/30 bg-status-info/5 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-soft-mute">Question text read again from the PDF</p>
              <div className="max-h-72 overflow-y-auto">
                <MathMarkdown className="text-sm">{reread}</MathMarkdown>
              </div>
              <div className="flex gap-2">
                <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "use_pdf_text", question_text: reread }, "use_pdf_text")}>
                  {busy === "use_pdf_text" ? "Saving…" : "Use PDF text"}
                </button>
                <button type="button" className={btn} onClick={() => setReread(null)}>
                  Discard
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {isLiveFix && (
              <>
                <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "confirm_live_fix" }, "confirm")}>
                  {busy === "confirm" ? "Saving…" : "Confirm"}
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
                  </button>
                )}
                <button
                  type="button"
                  className={sugg?.strong ? btn : btnPrimary}
                  disabled={disabled}
                  onClick={() => {
                    // Keeping a key that differs from the official one overrules it.
                    if (item.keyOverrulesOfficial && !window.confirm(`Keep ${item.key ?? "∅"}? This clears the official answer ${item.official} — the kept key overrules it.`)) return;
                    void run({ action: "keep_key" }, "keep_key");
                  }}
                >
                  {busy === "keep_key" ? "Saving…" : `Keep ${item.key ?? "∅"}`}
                </button>
                {editKey === null ? (
                  <button type="button" className={btn} disabled={disabled} onClick={() => setEditKey("")}>
                    Edit
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
              <button type="button" className={decision === "stem" ? btnPrimary : btn} disabled={busy !== null || !item.hasPdf} onClick={() => void reextract()}>
                {busy === "reextract" ? "Reading the PDF…" : "Re-extract"}
              </button>
            )}
            {!isLiveFix && decision === "figure" && !item.proposal && (
              <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "keep_figure" }, "keep_figure")} title="The stored figure / table / choices match the PDF">
                {busy === "keep_figure" ? "Saving…" : "Matches the PDF"}
              </button>
            )}
            {!isLiveFix && decision === "explanation" && (
              <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "regen_explanation" }, "regen")}>
                {busy === "regen" ? "Writing…" : "Rewrite the explanation"}
              </button>
            )}
            {!isLiveFix && decision === "approve" && (
              <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "approve" }, "approve")}>
                {busy === "approve" ? "Approving…" : "Looks right, approve"}
              </button>
            )}
            {(decision !== "key" || isLiveFix) && (
              <Link href={`/admin/questions/${item.id}`} className={btn}>
                Edit
              </Link>
            )}
            {pdfSrc && (
              <button type="button" className="text-xs text-soft-mute underline hover:text-charcoal" onClick={() => setShowPdf((s) => !s)}>
                {showPdf ? "Hide PDF page" : "Show PDF page"}
              </button>
            )}
            {!canWrite && <span className="text-xs text-soft-mute">QA accounts can look but not change shared questions.</span>}
          </div>
          {result && (
            <p role="status" className={result.ok ? "text-sm text-status-success" : "text-sm text-status-error"}>
              {result.text}
            </p>
          )}

          <details className="text-xs text-soft-mute">
            <summary className="cursor-pointer">Details</summary>
            <p className="mt-1">Key: {item.keySource.label} — {item.keySource.detail}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono">
              {item.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </details>
        </div>

        {showPdf && pdfSrc && (
          <iframe
            src={pdfSrc}
            loading="lazy"
            title={`PDF page ${item.pageNumber} for Q${item.number ?? "?"}`}
            className="h-[420px] w-full rounded-xl border border-divider bg-white"
          />
        )}
      </div>

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

function ValueBox({ title, field, value }: { title: string; field: string; value: unknown }) {
  const img = (u: string) => `/api/blob-image?u=${encodeURIComponent(u)}`;
  return (
    <div className="min-w-0 rounded-xl border border-divider bg-light-bg p-2">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-soft-mute">{title}</p>
      {field === "image_urls" ? (
        Array.isArray(value) && value.length ? (
          value.map((u) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={String(u)} src={img(String(u))} alt={title} className="max-h-56 w-auto max-w-full rounded border border-divider bg-white" />
          ))
        ) : (
          <span className="text-sm text-soft-mute">(none)</span>
        )
      ) : field === "choices" && Array.isArray(value) ? (
        <ul className="space-y-0.5 text-sm">
          {(value as { label?: string; text?: string }[]).map((c, i) => (
            <li key={i} className="flex gap-2">
              <span className="font-semibold">{c?.label}</span>
              <MathMarkdown className="min-w-0 flex-1 text-sm">{c?.text || "(empty)"}</MathMarkdown>
            </li>
          ))}
        </ul>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          <MathMarkdown className="text-sm">{value === null || value === undefined || value === "" ? "(empty)" : String(value)}</MathMarkdown>
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
  /** Undo of a live-test change: the key goes back together with the earlier content. */
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
