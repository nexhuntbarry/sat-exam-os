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
}: {
  summary: GroupSummary[];
  items: QueueItem[];
  canWrite: boolean;
  initialGroup?: string | null;
}) {
  const firstWaiting = summary.find((g) => g.waiting > 0)?.id ?? summary[0].id;
  const group: GroupId = (summary.find((g) => g.id === initialGroup)?.id ?? firstWaiting) as GroupId;
  const current = summary.find((g) => g.id === group)!;
  const list = items.filter((i) => i.primary === group);
  const totalWaiting = summary.reduce((n, g) => n + g.waiting, 0);
  const totalFixed = summary.reduce((n, g) => n + g.autoFixed, 0);
  const labelOf = (id: GroupId) => summary.find((g) => g.id === id)?.label ?? id;

  return (
    <div className="space-y-6">
      <section aria-label="Summary" className="space-y-2">
        <p className="text-sm text-charcoal">
          <strong>{totalWaiting}</strong> question{totalWaiting === 1 ? "" : "s"} waiting for a person ·{" "}
          <strong>{totalFixed}</strong> fixed automatically and approved
        </p>
        <DataTable>
          <thead>
            <HeadRow>
              <Th kind="main" sticky="left">Reason</Th>
              <Th>Waiting</Th>
              <Th>Fixed automatically</Th>
              <Th kind="long" className="w-[50%]">Why still waiting</Th>
            </HeadRow>
          </thead>
          <tbody>
            {summary.map((g) => (
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
        {list.map((item) => (
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
  const [showPdf, setShowPdf] = useState(decision === "key" || decision === "stem" || (decision === "figure" && !item.proposal));
  const [editKey, setEditKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ key: string; data: Preview } | null>(null);
  const [reread, setReread] = useState<string | null>(null);

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
  async function startKeyChange(key: string) {
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
      if (data.attempts > 0 || data.live) {
        setPreview({ key: k, data });
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

  const pdfSrc = item.hasPdf && item.moduleId && item.pageNumber ? `/api/modules/${item.moduleId}/page/${item.pageNumber}` : null;
  const disabled = !canWrite || busy !== null;

  return (
    <article className="rounded-2xl border border-divider bg-surface p-4" data-testid="queue-card" data-question-id={item.id}>
      <header className="flex flex-wrap items-center gap-2">
        <Link href={`/admin/questions/${item.id}`} className="font-semibold text-charcoal hover:text-warm-coral-text">
          Q{item.number ?? "?"} · {item.moduleName}
        </Link>
        <SubjectTag section={item.section} />
        <StatusBadge kind="question" status="Needs Review" />
        {item.also.length > 0 && <span className="text-xs text-soft-mute">Also: {item.also.map(labelOf).join(", ")}</span>}
        {!item.hasPdf && <span className="text-xs text-soft-mute">Source PDF unavailable</span>}
      </header>

      <div className={cn("mt-3 grid gap-4", showPdf && pdfSrc ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "")}>
        <div className="min-w-0 space-y-3">
          {decision === "key" && (
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
              <span>
                Key says <strong className="font-mono text-base">{item.key ?? "∅"}</strong>
              </span>
              {item.alternative && (
                <span>
                  {item.alternative.source} says <strong className="font-mono text-base">{item.alternative.answer}</strong>
                  {item.alternative.ref ? <span className="text-soft-mute"> ({item.alternative.ref})</span> : null}
                </span>
              )}
              {item.official && item.official !== item.key && item.alternative?.answer !== item.official && (
                <span>
                  Official key <strong className="font-mono">{item.official}</strong>
                </span>
              )}
              {item.official && item.official === item.key && <span className="text-soft-mute">(the key is the official key)</span>}
            </div>
          )}

          {(decision === "stem" || decision === "key" || decision === "explanation" || decision === "approve" || decision === "render" || decision === "key_format" || (decision === "figure" && !item.proposal)) && (
            <details className="text-sm" open={decision === "stem" || decision === "figure"}>
              <summary className="cursor-pointer text-xs text-soft-mute">Stored question</summary>
              <div className="mt-2 max-h-72 overflow-y-auto rounded-lg bg-light-bg p-3">
                <MathMarkdown className="text-sm">{item.stem || "(empty)"}</MathMarkdown>
                {item.choices.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {item.choices.map((c) => (
                      <li key={c.label} className="flex gap-2">
                        <span className="font-semibold">{c.label}</span>
                        <MathMarkdown className="min-w-0 flex-1 text-sm">{c.text || (c.image_url ? "(graph)" : "(empty)")}</MathMarkdown>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>
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

          <details className="text-xs text-soft-mute">
            <summary className="cursor-pointer">Why it&rsquo;s here ({item.reasons.length})</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {item.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            {decision === "key" && (
              <>
                <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "keep_key" }, "keep_key")}>
                  {busy === "keep_key" ? "Saving…" : "Keep key"}
                </button>
                {item.alternative && (
                  <button type="button" className={btn} disabled={disabled} onClick={() => void startKeyChange(item.alternative!.answer)}>
                    {busy === "preview" ? "Checking…" : `Use ${item.alternative.source.startsWith("official") ? "official" : "AI"} answer (${item.alternative.answer})`}
                  </button>
                )}
                {editKey === null ? (
                  <button type="button" className={btn} disabled={disabled} onClick={() => setEditKey("")}>
                    Edit key
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
            {decision === "key_format" && (
              <Link href="/admin/questions/key-check" className={btnPrimary}>
                Open answer key check
              </Link>
            )}
            {(decision === "stem" || (decision === "figure" && !item.proposal)) && (
              <button type="button" className={decision === "stem" ? btnPrimary : btn} disabled={busy !== null || !item.hasPdf} onClick={() => void reextract()}>
                {busy === "reextract" ? "Reading the PDF…" : "Re-extract"}
              </button>
            )}
            {decision === "figure" && !item.proposal && (
              <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "keep_figure" }, "keep_figure")} title="The stored figure / table / choices match the PDF">
                {busy === "keep_figure" ? "Saving…" : "Matches the PDF"}
              </button>
            )}
            {decision === "explanation" && (
              <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "regen_explanation" }, "regen")}>
                {busy === "regen" ? "Writing…" : "Regenerate explanation"}
              </button>
            )}
            {decision === "approve" && (
              <button type="button" className={btnPrimary} disabled={disabled} onClick={() => void run({ action: "approve" }, "approve")}>
                {busy === "approve" ? "Approving…" : "Looks right, approve"}
              </button>
            )}
            <Link href={`/admin/questions/${item.id}`} className={btn}>
              Edit
            </Link>
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
          busy={busy === "set_key"}
          canWrite={canWrite}
          onCancel={() => setPreview(null)}
          onConfirm={() => void run({ action: "set_key", key: preview.key, expected_key: item.key, rescore: true }, "set_key")}
        />
      )}
    </article>
  );
}

function KeyChangeDialog({
  item,
  newKey,
  preview,
  busy,
  canWrite,
  onCancel,
  onConfirm,
}: {
  item: QueueItem;
  newKey: string;
  preview: Preview;
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
              Q{item.number ?? "?"} · change the key {item.key ?? "∅"} → {newKey}
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
              {busy ? "Applying…" : `Confirm: change the key and rescore ${preview.changes.length} attempt${preview.changes.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
