"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { upload } from "@vercel/blob/client";
import { FileUp, Loader2, RefreshCw } from "lucide-react";

interface Counts {
  pending: number;
  match: number;
  diff: number;
}

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; pct: number }
  | { kind: "attaching" }
  | { kind: "checking"; done: number; total: number }
  | { kind: "error"; message: string };

// "Replace source PDF": upload a new PDF for this module (same client upload
// as module creation), attach it without re-parsing, then compare every
// question with it in batches (POST compare-pdf until nothing is pending).
export default function ReplacePdfButton({ moduleId, initialCounts }: { moduleId: string; initialCounts: Counts }) {
  const router = useRouter();
  const t = useTranslations("moduleDetail");
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [counts, setCounts] = useState<Counts>(initialCounts);
  const busy = phase.kind === "uploading" || phase.kind === "attaching" || phase.kind === "checking";

  async function runChecks(pendingAtStart: number) {
    let done = 0;
    setPhase({ kind: "checking", done, total: pendingAtStart });
    for (let round = 0; round < 50; round++) {
      const res = await fetch(`/api/admin/modules/${moduleId}/compare-pdf`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
        break;
      }
      done += json.checked ?? 0;
      setPhase({ kind: "checking", done, total: pendingAtStart });
      if (!json.remaining || !json.checked) {
        setPhase({ kind: "idle" });
        break;
      }
    }
    const c = await fetch(`/api/admin/modules/${moduleId}/compare-pdf`).then((r) => r.json()).catch(() => null);
    if (c) setCounts(c);
    router.refresh();
  }

  async function onFile(file: File) {
    if (!window.confirm(t("replaceConfirm", { name: file.name }))) return;
    try {
      setPhase({ kind: "uploading", pct: 0 });
      // Private store: access must match (see modules/new).
      const blob = await upload(`modules/${Date.now()}-${file.name}`, file, {
        access: "private" as "public",
        handleUploadUrl: "/api/upload/handle",
        multipart: false,
        onUploadProgress: ({ percentage }) => setPhase({ kind: "uploading", pct: Math.round(percentage) }),
      });
      setPhase({ kind: "attaching" });
      const res = await fetch(`/api/admin/modules/${moduleId}/replace-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdfUrl: blob.url }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      setCounts({ pending: json.questions ?? 0, match: 0, diff: 0 });
      router.refresh();
      await runChecks(json.questions ?? 0);
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const checked = counts.match + counts.diff;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          aria-label={t("replacePdf")}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void onFile(f);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-light-bg text-charcoal text-sm transition-colors hover:opacity-80 disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
          {phase.kind === "uploading"
            ? t("replaceUploading", { pct: phase.pct })
            : phase.kind === "attaching"
            ? t("replaceAttaching")
            : phase.kind === "checking"
            ? t("replaceChecking", { done: phase.done, total: phase.total })
            : t("replacePdf")}
        </button>
        {!busy && counts.pending > 0 && (
          <button
            type="button"
            onClick={() => void runChecks(counts.pending)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-warm-coral/15 text-warm-coral-text text-sm hover:bg-warm-coral/25 transition-colors"
          >
            <RefreshCw size={13} />
            {t("replaceContinue", { count: counts.pending })}
          </button>
        )}
      </div>
      {(checked > 0 || counts.pending > 0) && (
        <p className="text-xs text-mid-gray" data-testid="pdf-check-summary">
          {t("replaceSummary", { match: counts.match, diff: counts.diff, pending: counts.pending })}
        </p>
      )}
      {phase.kind === "error" && <p className="text-xs text-status-error">{phase.message}</p>}
    </div>
  );
}
