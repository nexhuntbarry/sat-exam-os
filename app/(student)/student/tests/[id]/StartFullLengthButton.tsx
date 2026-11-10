"use client";

import { useEffect, useState } from "react";
import { Play, RotateCcw } from "lucide-react";

interface Props {
  /** The full-length (parent) test id. */
  testId: string;
  isResume: boolean;
  label?: string;
}

// Start / Resume / Retake of a full-length SAT. Always goes through POST
// .../start (it resumes a running attempt, and repairs one whose first
// module is missing), then opens the full-length runner with a full page
// load. Disabled until hydrated, like StartTestButton.
export default function StartFullLengthButton({ testId, isResume, label }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function handleStart() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/student/full-length/${testId}/start`, { method: "POST", cache: "no-store" });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok || json === null) {
        throw new Error(json?.error ?? `Server error (${res.status}). Please try again.`);
      }
      window.location.assign(`/student/tests/${testId}/sat`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-status-error text-sm text-center">{error}</p>}
      <button
        onClick={handleStart}
        disabled={loading || !hydrated}
        className="w-full py-4 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-bold text-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
      >
        {isResume ? <RotateCcw size={20} /> : <Play size={20} />}
        {loading || !hydrated ? "Loading..." : label ?? (isResume ? "Resume Test" : "Start Test")}
      </button>
    </div>
  );
}
