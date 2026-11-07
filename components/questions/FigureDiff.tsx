"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import MathMarkdown from "@/components/MathMarkdown";

export interface FigureDiffChoice {
  label: string;
  text: string;
  image_url?: string | null;
}

export interface FigureDiffProposal {
  parts: string[];
  diffs: string[];
  pages: string;
  stored: { choices?: FigureDiffChoice[]; table?: string; imageUrls?: string[] };
  pdf: { choices?: FigureDiffChoice[]; table?: string; imageUrls?: string[] };
}

export interface DecideResponse {
  approved?: boolean;
  blockers?: string[];
  nextGroup?: string | null;
  explanation?: string;
  error?: string;
}

/** POST one review-queue decision. */
export async function postDecision(body: Record<string, unknown>): Promise<{ ok: boolean; json: DecideResponse }> {
  try {
    const res = await fetch("/api/admin/review-queue/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as DecideResponse;
    return { ok: res.ok, json };
  } catch {
    return { ok: false, json: { error: "Network error. Try again." } };
  }
}

/** "Approved" / "Still in review: …" line for a decision result. */
export function describeDecision(json: DecideResponse): string {
  if (json.approved) return "Approved.";
  const why = json.blockers?.[0] ? ` Still in review: ${json.blockers[0].replace(/^note: /, "")}` : " Still in review.";
  const ex = json.explanation === "ai_disagrees" ? " The AI's own answer differs from the key, so the key is queued for a decision." : json.explanation === "failed" ? " The explanation couldn't be rewritten automatically." : "";
  return `Saved.${why}${ex}`;
}

const img = (u: string) => `/api/blob-image?u=${encodeURIComponent(u)}`;

function Side({ title, v }: { title: string; v: FigureDiffProposal["stored"] }) {
  return (
    <div className="min-w-0 space-y-2 rounded-xl border border-divider bg-surface p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-soft-mute">{title}</p>
      {v.imageUrls?.map((u) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={u} src={img(u)} alt={`${title} figure`} className="max-h-72 w-auto max-w-full rounded border border-divider bg-white" />
      ))}
      {v.table && <MathMarkdown className="overflow-x-auto text-sm">{v.table}</MathMarkdown>}
      {v.choices && (
        <ul className="space-y-1 text-sm">
          {v.choices.map((c) => (
            <li key={c.label} className="flex gap-2">
              <span className="font-semibold text-charcoal">{c.label}</span>
              {c.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img(c.image_url)} alt={`Choice ${c.label}`} className="max-h-32 rounded border border-divider" />
              ) : (
                <MathMarkdown className="min-w-0 flex-1">{c.text || "(empty)"}</MathMarkdown>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Stored figure / table / choices next to the PDF version (figure check,
 * lib/figure-compare.ts) with "Use PDF version" / "Keep".
 */
export default function FigureDiff({
  questionId,
  updatedAt,
  proposal,
  canWrite,
  onDone,
  reloadOnDone,
}: {
  questionId: string;
  updatedAt: string | null;
  proposal: FigureDiffProposal;
  canWrite: boolean;
  onDone?: (message: string, ok: boolean) => void;
  /** Reload the whole page after a decision (the question editor keeps its own copy). */
  reloadOnDone?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"use_pdf" | "keep_figure" | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function run(action: "use_pdf" | "keep_figure") {
    setBusy(action);
    setMsg(null);
    const { ok, json } = await postDecision({ id: questionId, action, updated_at: updatedAt });
    const text = ok ? describeDecision(json) : json.error ?? "That didn't work.";
    setBusy(null);
    if (onDone) onDone(text, ok);
    else setMsg({ text, ok });
    if (ok && reloadOnDone) window.setTimeout(() => window.location.reload(), 1200);
    else if (ok) router.refresh();
  }

  return (
    <div className="space-y-3" data-testid="figure-diff">
      <p className="text-sm text-charcoal">
        The stored <strong>{proposal.parts.join(", ")}</strong> differ from the source PDF (page {proposal.pages}).
      </p>
      <ul className="list-disc pl-5 text-xs text-mid-gray">
        {proposal.diffs.slice(0, 6).map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <div className="grid gap-3 md:grid-cols-2">
        <Side title="Stored" v={proposal.stored} />
        <Side title="PDF version" v={proposal.pdf} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canWrite || busy !== null}
          onClick={() => void run("use_pdf")}
          className="rounded-lg bg-warm-coral px-3 py-1.5 text-sm font-semibold text-white hover:bg-warm-coral-dark disabled:opacity-50"
        >
          {busy === "use_pdf" ? "Applying…" : "Use PDF version"}
        </button>
        <button
          type="button"
          disabled={!canWrite || busy !== null}
          onClick={() => void run("keep_figure")}
          className="rounded-lg border border-divider bg-surface px-3 py-1.5 text-sm text-charcoal hover:bg-light-bg disabled:opacity-50"
        >
          {busy === "keep_figure" ? "Saving…" : "Keep"}
        </button>
        {!canWrite && <span className="text-xs text-soft-mute">QA accounts can look but not change shared questions.</span>}
      </div>
      {msg && (
        <p role="status" className={msg.ok ? "text-sm text-status-success" : "text-sm text-status-error"}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
