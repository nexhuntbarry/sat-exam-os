"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

interface Props {
  testId: string;
  filename?: string;
}

export function ExportCsvButton({ testId, filename }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/teacher/tests/${testId}/export`);
      if (!res.ok) {
        throw new Error(`Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename ?? `test-${testId}-results.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-amber/10 border border-warm-amber/20 text-warm-amber text-sm font-medium hover:bg-warm-amber/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        aria-busy={loading}
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {loading ? "Exporting…" : "Export CSV"}
      </button>
      {error && (
        <span role="alert" className="text-xs text-warm-coral">
          {error}
        </span>
      )}
    </div>
  );
}
