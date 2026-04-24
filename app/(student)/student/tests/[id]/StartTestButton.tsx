"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, RotateCcw } from "lucide-react";

interface Props {
  testId: string;
  submissionId?: string;
  isResume: boolean;
}

export default function StartTestButton({ testId, submissionId, isResume }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleStart() {
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
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to start test");

      router.push(`/student/tests/${testId}/take`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-rose text-sm text-center">{error}</p>}
      <button
        onClick={handleStart}
        disabled={loading}
        className="w-full py-4 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-bold text-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
      >
        {isResume ? <RotateCcw size={20} /> : <Play size={20} />}
        {loading ? "Loading..." : isResume ? "Resume Test" : "Start Test"}
      </button>
    </div>
  );
}
