"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Play, RotateCcw } from "lucide-react";

interface Props {
  testId: string;
  submissionId?: string;
  isResume: boolean;
  /** Overrides the default "Start Test" / "Resume Test" text. */
  label?: string;
}

export default function StartTestButton({ testId, submissionId, isResume, label }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // On a slow connection the server-rendered button shows seconds before
  // React hydrates, and a click in that window did nothing — students had
  // to guess they should press again. Keep it visibly disabled until ready.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  // A double-click must open exactly one exam: the second click can arrive
  // before React re-renders the button as disabled.
  const starting = useRef(false);
  // Back button restores this page from bfcache with loading still set; unlock it.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) { starting.current = false; setLoading(false); }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  async function handleStart() {
    if (starting.current) return;
    starting.current = true;
    setLoading(true);
    setError("");
    try {
      if (isResume && submissionId) {
        router.push(`/student/tests/${testId}/take`);
        return;
      }

      const res = await fetch("/api/student/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testId }),
      });
      const text = await res.text();
      let json: { error?: string } | null = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (!res.ok || json === null) {
        throw new Error(json?.error ?? `Server error (${res.status}). Please try again.`);
      }

      router.push(`/student/tests/${testId}/take`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setLoading(false);
      starting.current = false;
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
