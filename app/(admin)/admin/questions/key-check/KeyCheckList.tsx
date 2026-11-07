"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { DataTable, HeadRow, Th, Td, DataRow, EmptyRow, RowActions, RowButton, TwoLineCell, TruncatedText } from "@/components/ui/data-table";
import { Portal } from "@/components/ui/Portal";
import type { KeyCheckFinding, KeyChangePreview, KeyCorrection } from "@/lib/key-check";

const TYPE_LABEL: Record<string, string> = {
  "Multiple Choice": "Multiple choice",
  "Student Produced Response": "Fill-in (SPR)",
};

function describe(s: KeyCorrection, key: string | null): string {
  return [
    s.question_type ? `type → ${TYPE_LABEL[s.question_type] ?? s.question_type}` : null,
    s.correct_answer !== undefined ? `key ${key ?? "∅"} → ${s.correct_answer}` : null,
    s.clear_choices ? "remove the choices" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

type Preview = KeyChangePreview & { keyChanged: boolean; stillMismatched: string | null; live: boolean };

export default function KeyCheckList({ findings, canApply }: { findings: KeyCheckFinding[]; canApply: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<KeyCheckFinding | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});

  async function startApply(f: KeyCheckFinding) {
    if (!f.suggestion) return;
    setOpen(f);
    setPreview(null);
    setError(null);
    setBusy("preview");
    try {
      const res = await fetch("/api/admin/key-check/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: f.id, ...f.suggestion }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) setPreview(json as Preview);
      else setError(json.error ?? "Couldn't load the preview.");
    } catch {
      setError("Couldn't load the preview.");
    } finally {
      setBusy(null);
    }
  }

  async function confirmApply() {
    if (!open?.suggestion || !preview) return;
    setBusy("apply");
    setError(null);
    try {
      const res = await fetch("/api/admin/key-check/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: open.id, ...open.suggestion, expected_key: open.key, rescore: preview.keyChanged }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Apply failed.");
        return;
      }
      const r = json.rescore as { recordsUpdated: number; submissionsRescored: number } | null;
      setDone((d) => ({
        ...d,
        [open.id]: `Applied${r ? ` · ${r.submissionsRescored} attempt${r.submissionsRescored === 1 ? "" : "s"} rescored` : ""}${json.live ? " · kept Approved ([live-fix])" : ""}${json.rescoreError ? ` · ${json.rescoreError}` : ""}${json.warning ? ` · ${json.warning}` : ""}`,
      }));
      setOpen(null);
      setPreview(null);
      router.refresh();
    } catch {
      setError("Apply failed.");
    } finally {
      setBusy(null);
    }
  }

  const close = () => {
    if (busy === "apply") return;
    setOpen(null);
    setPreview(null);
    setError(null);
  };

  return (
    <>
      <p className="text-sm text-charcoal">
        {findings.length} question{findings.length === 1 ? "" : "s"} found · {findings.filter((f) => f.suggestion).length} with a suggested
        correction · {findings.filter((f) => f.live).length} in a live test
      </p>
      <DataTable>
        <thead>
          <HeadRow>
            <Th kind="main" sticky="left">Question</Th>
            <Th>Type · key</Th>
            <Th kind="long">Problem</Th>
            <Th kind="long">Suggested correction</Th>
            <Th kind="actions" sticky="right"><span className="sr-only">Actions</span></Th>
          </HeadRow>
        </thead>
        <tbody>
          {findings.length === 0 && <EmptyRow colSpan={5}>No answer-key problems found.</EmptyRow>}
          {findings.map((f) => (
            <DataRow key={f.id} href={`/admin/questions/${f.id}`}>
              <Td kind="main" sticky="left">
                <Link href={`/admin/questions/${f.id}`} className="block hover:text-warm-coral-text transition-colors">
                  <TwoLineCell
                    main={`Q${f.number ?? "?"} · ${f.moduleName ?? "Unknown module"}`}
                    detail={`${f.status ?? "?"}${f.live ? " · LIVE test" : ""} · ${f.excerpt}`}
                    wrapMain
                    mainClassName="font-medium text-inherit"
                  />
                </Link>
              </Td>
              <Td>
                <TwoLineCell
                  main={TYPE_LABEL[f.questionType ?? ""] ?? f.questionType ?? "—"}
                  detail={`key ${f.key ?? "∅"}${f.officialAnswer && f.officialAnswer !== f.key ? ` · official ${f.officialAnswer}` : ""}`}
                />
              </Td>
              <Td kind="long">
                <TruncatedText title={f.reason}>{f.reason}</TruncatedText>
              </Td>
              <Td kind="long">
                {f.suggestion ? (
                  <TruncatedText title={`${describe(f.suggestion, f.key)} — from ${f.suggestionWhy}`}>
                    {describe(f.suggestion, f.key)}
                  </TruncatedText>
                ) : (
                  <span className="text-xs text-soft-mute">Open the question · use AI suggestion</span>
                )}
              </Td>
              <Td kind="actions" sticky="right">
                <RowActions>
                  {done[f.id] ? (
                    <span className="text-xs text-warm-amber">{done[f.id]}</span>
                  ) : f.suggestion ? (
                    <RowButton
                      label="Apply"
                      tone="primary"
                      onClick={() => void startApply(f)}
                      title="Preview the change and the affected attempts, then confirm"
                    />
                  ) : (
                    <RowButton label="Open" href={`/admin/questions/${f.id}`} />
                  )}
                </RowActions>
              </Td>
            </DataRow>
          ))}
        </tbody>
      </DataTable>

      {open && (
        <Portal>
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Apply answer key correction"
              onClick={(e) => e.stopPropagation()}
              className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-surface p-5 shadow-xl space-y-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-charcoal">
                    Q{open.number ?? "?"} · {open.moduleName ?? "Unknown module"}
                  </h2>
                  <p className="text-sm text-mid-gray">{open.reason}</p>
                </div>
                <button type="button" onClick={close} aria-label="Close" className="rounded-md p-1 text-soft-mute hover:bg-light-bg hover:text-charcoal">
                  <X size={18} />
                </button>
              </div>

              {open.suggestion && (
                <p className="rounded-lg bg-light-bg px-3 py-2 text-sm text-charcoal">
                  Change: <strong>{describe(open.suggestion, open.key)}</strong>
                  <span className="block text-xs text-soft-mute">From {open.suggestionWhy}.</span>
                </p>
              )}

              {busy === "preview" && <p className="text-sm text-soft-mute">Working out which attempts change…</p>}
              {error && <p role="alert" className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">{error}</p>}

              {preview && (
                <div className="space-y-3">
                  {preview.stillMismatched && (
                    <p role="alert" className="rounded-lg bg-status-error/10 px-3 py-2 text-sm text-status-error">
                      This correction still doesn&rsquo;t fit: {preview.stillMismatched}. Fix it on the question page instead.
                    </p>
                  )}
                  {preview.live && (
                    <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
                      This question is in a live test. It stays Approved and gets a [live-fix] note.
                    </p>
                  )}
                  {preview.keyChanged ? (
                    <>
                      <p className="text-sm text-charcoal">
                        {preview.attempts} graded answer{preview.attempts === 1 ? "" : "s"} to this question ·{" "}
                        <strong>{preview.changes.length} would change</strong> when rescored. Explanation is rewritten for the new key.
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
                                  <td className="px-3 py-1.5 whitespace-nowrap">
                                    {c.oldCorrect}/{c.total} → <strong>{c.newCorrect}/{c.total}</strong>
                                    <span className="text-soft-mute"> · {c.oldScaled ?? "—"} → {c.newScaled}</span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-charcoal">The key stays the same, so no attempt is regraded.</p>
                  )}
                  {!canApply && (
                    <p className="text-xs text-soft-mute">QA accounts can preview but cannot change shared questions.</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={close} className="rounded-lg px-3 py-1.5 text-sm text-charcoal hover:bg-light-bg">
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void confirmApply()}
                      disabled={!!preview.stillMismatched || busy !== null || !canApply}
                      className="rounded-lg bg-warm-coral px-3 py-1.5 text-sm font-semibold text-white hover:bg-warm-coral-dark disabled:opacity-50"
                    >
                      {busy === "apply"
                        ? "Applying…"
                        : preview.keyChanged
                          ? `Confirm: change the key and rescore ${preview.changes.length} attempt${preview.changes.length === 1 ? "" : "s"}`
                          : "Confirm change"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
