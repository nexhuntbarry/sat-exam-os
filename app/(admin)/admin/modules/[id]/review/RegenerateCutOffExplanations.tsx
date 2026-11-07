"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

interface Outcome {
  id: string;
  number: number | null;
  status: "regenerated" | "failed" | "skipped";
  aiAnswer?: string;
  liveFix?: boolean;
}

// "Regenerate all cut-off explanations in this module". Lists the targets,
// then sends them in small batches (each call fits the function time limit).
// Results go into the explanation; questions stay in review — never approved.
export default function RegenerateCutOffExplanations({ moduleId }: { moduleId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  async function post(body: object) {
    const res = await fetch(`/api/admin/modules/${moduleId}/regenerate-explanations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Failed (${res.status})`);
    return json;
  }

  async function run() {
    setSummary(null);
    setBusy(true);
    setProgress("Finding cut-off explanations…");
    const done: Outcome[] = [];
    try {
      const { targets, batch } = (await post({})) as { targets: { id: string }[]; batch: number };
      if (targets.length === 0) {
        setSummary("No cut-off explanations in this module.");
        return;
      }
      if (
        !window.confirm(
          `Regenerate ${targets.length} cut-off explanation(s) with AI?\n\nOnly the explanation is rewritten (the answer is never changed). The questions stay in review — Approved ones go back to Needs Review, except questions in a live test, which stay Approved with a [live-fix] note.`,
        )
      ) {
        return;
      }
      for (let i = 0; i < targets.length; i += batch) {
        setProgress(`Regenerating ${Math.min(i + batch, targets.length)} of ${targets.length}…`);
        const { results } = (await post({ question_ids: targets.slice(i, i + batch).map((t) => t.id) })) as { results: Outcome[] };
        done.push(...results);
      }
    } catch (e) {
      setSummary(`Stopped: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setBusy(false);
      setProgress(null);
      if (done.length > 0) {
        const ok = done.filter((r) => r.status === "regenerated");
        const failed = done.filter((r) => r.status === "failed");
        const disagree = ok.filter((r) => r.aiAnswer);
        const live = ok.filter((r) => r.liveFix);
        const nums = (rs: Outcome[]) => rs.map((r) => `Q${r.number ?? "?"}`).join(", ");
        setSummary(
          [
            `Regenerated ${ok.length} explanation(s)`,
            failed.length ? `couldn't produce a complete explanation for ${nums(failed)}` : "",
            disagree.length ? `AI disagrees with the saved key on ${disagree.map((r) => `Q${r.number ?? "?"} (AI: ${r.aiAnswer})`).join(", ")} — check those keys` : "",
            live.length ? `${nums(live)} kept Approved (live test, [live-fix] note)` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        );
        router.refresh();
      }
    }
  }

  return (
    <div className="flex items-center gap-2">
      {(progress || summary) && (
        <span role="status" className="max-w-md text-xs text-mid-gray bg-light-bg px-3 py-1.5 rounded-lg">
          {progress ?? summary}
        </span>
      )}
      <button
        onClick={run}
        disabled={busy}
        title="Rewrite every explanation in this module that looks cut off. Questions stay in review."
        className="flex items-center gap-2 px-3 py-2 rounded-xl bg-surface border border-divider hover:bg-light-bg text-charcoal text-sm font-medium transition-colors disabled:opacity-50"
      >
        <Sparkles size={14} />
        {busy ? "Regenerating…" : "Regenerate all cut-off explanations"}
      </button>
    </div>
  );
}
