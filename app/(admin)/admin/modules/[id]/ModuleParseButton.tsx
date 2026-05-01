"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Cpu, Loader2, AlertCircle, RefreshCw, CheckCircle2, KeyRound, ScanSearch } from "lucide-react";

interface ModuleParseButtonProps {
  moduleId: string;
  initialStatus: string;
  labels?: {
    parse?: string;
    retry?: string;
    starting?: string;
    parsing?: string;
  };
}

type Phase =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "probe-found"; count: number; answers: Record<string, string>; notes: string | null }
  | { kind: "probe-missing"; notes: string | null }
  | { kind: "starting" }
  | { kind: "error"; message: string };

export default function ModuleParseButton({ moduleId, initialStatus, labels }: ModuleParseButtonProps) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll while parsing.
  useEffect(() => {
    if (status === "parsing") {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/admin/modules/${moduleId}`);
          if (res.ok) {
            const json = await res.json();
            const newStatus = json.data?.parsing_status;
            if (newStatus && newStatus !== "parsing") {
              setStatus(newStatus);
              clearInterval(pollRef.current!);
              router.refresh();
            }
          }
        } catch {
          // ignore poll errors
        }
      }, 5000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status, moduleId, router]);

  async function startProbe() {
    setPhase({ kind: "probing" });
    try {
      const res = await fetch(`/api/admin/modules/${moduleId}/probe-answer-key`, {
        method: "POST",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase({ kind: "error", message: json.error ?? "Probe failed" });
        return;
      }
      if (json.found && json.count > 0) {
        setPhase({
          kind: "probe-found",
          count: json.count,
          answers: json.answers ?? {},
          notes: json.notes ?? null,
        });
      } else {
        setPhase({ kind: "probe-missing", notes: json.notes ?? null });
      }
    } catch {
      setPhase({ kind: "error", message: "Network error during probe" });
    }
  }

  async function startParse(answerKey: Record<string, string> | null) {
    setPhase({ kind: "starting" });
    setStatus("parsing");
    try {
      const res = await fetch(`/api/admin/modules/${moduleId}/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: answerKey ? JSON.stringify({ answerKey }) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPhase({ kind: "error", message: json.error ?? "Failed to start parsing" });
        router.refresh();
        return;
      }
      setPhase({ kind: "idle" });
      router.refresh();
    } catch {
      setPhase({ kind: "error", message: "Network error during parse" });
      router.refresh();
    }
  }

  function cancel() {
    setPhase({ kind: "idle" });
  }

  // ── Renderers ───────────────────────────────────────────

  if (status === "parsing") {
    return (
      <div className="flex items-center gap-2 text-status-warning text-sm font-medium">
        <Loader2 size={15} className="animate-spin" />
        {labels?.parsing ?? "Parsing… (1-3 min)"}
      </div>
    );
  }

  const isRetry = status === "failed";

  // Modal-style inline confirmation panels.
  if (phase.kind === "probing") {
    return (
      <div className="rounded-xl border border-warm-amber/30 bg-warm-amber/10 p-4 max-w-md">
        <div className="flex items-center gap-2 text-warm-amber text-sm font-medium mb-1">
          <ScanSearch size={15} className="animate-pulse" />
          Scanning last pages for an answer key…
        </div>
        <p className="text-mid-gray text-xs">
          This usually takes 10-30 seconds. Reading the final 1-3 pages with Claude Haiku.
        </p>
      </div>
    );
  }

  if (phase.kind === "probe-found") {
    return (
      <div className="rounded-xl border border-status-success/30 bg-status-success/10 p-4 max-w-md space-y-3">
        <div className="flex items-start gap-2">
          <CheckCircle2 size={16} className="text-status-success shrink-0 mt-0.5" />
          <div>
            <p className="text-charcoal text-sm font-semibold">
              Answer key found — {phase.count} answers extracted
            </p>
            <p className="text-mid-gray text-xs mt-1">
              Each question will be parsed AND solved by AI, then cross-checked against the
              official key. Mismatches will be flagged for review.
            </p>
            {phase.notes && (
              <p className="text-soft-mute text-xs mt-1 italic">Note: {phase.notes}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => startParse(phase.answers)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
          >
            <KeyRound size={14} />
            Parse with Answer Key
          </button>
          <button
            onClick={cancel}
            className="px-3 py-2 rounded-xl text-mid-gray hover:text-charcoal text-sm transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "probe-missing") {
    return (
      <div className="rounded-xl border border-status-warning/30 bg-status-warning/10 p-4 max-w-md space-y-3">
        <div className="flex items-start gap-2">
          <AlertCircle size={16} className="text-status-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-charcoal text-sm font-semibold">
              No answer key found on the last pages
            </p>
            <p className="text-mid-gray text-xs mt-1">
              The AI will solve every question on its own. Low-confidence answers will still be
              flagged as &ldquo;Needs Review&rdquo;, but there is no ground truth to verify
              against. We recommend uploading a PDF that includes the official answer key.
            </p>
            {phase.notes && (
              <p className="text-soft-mute text-xs mt-1 italic">Note: {phase.notes}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => startParse(null)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
          >
            <Cpu size={14} />
            Parse with AI Only
          </button>
          <button
            onClick={cancel}
            className="px-3 py-2 rounded-xl text-mid-gray hover:text-charcoal text-sm transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Default: Parse button (idle / starting / error).
  const label = phase.kind === "starting"
    ? labels?.starting ?? "Starting..."
    : isRetry
      ? labels?.retry ?? "Retry Parse"
      : labels?.parse ?? "Parse & Add to Question Bank";

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={startProbe}
        disabled={phase.kind === "starting"}
        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm shrink-0 disabled:opacity-60 transition-colors"
      >
        {phase.kind === "starting" ? (
          <Loader2 size={15} className="animate-spin" />
        ) : isRetry ? (
          <RefreshCw size={15} />
        ) : (
          <Cpu size={15} />
        )}
        {label}
      </button>
      {phase.kind === "error" && (
        <div className="flex items-center gap-1.5 text-status-error text-xs">
          <AlertCircle size={12} />
          {phase.message}
        </div>
      )}
    </div>
  );
}
