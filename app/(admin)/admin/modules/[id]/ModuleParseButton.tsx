"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Cpu, Loader2, AlertCircle, RefreshCw } from "lucide-react";

interface ModuleParseButtonProps {
  moduleId: string;
  initialStatus: string;
}

export default function ModuleParseButton({ moduleId, initialStatus }: ModuleParseButtonProps) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll while parsing
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

  async function handleParse() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/modules/${moduleId}/parse`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Failed to start parsing");
        return;
      }
      setStatus("parsing");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (status === "parsing") {
    return (
      <div className="flex items-center gap-2 text-amber text-sm font-medium">
        <Loader2 size={15} className="animate-spin" />
        Parsing… (1-3 min)
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={handleParse}
        disabled={loading}
        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm shrink-0 disabled:opacity-60 transition-colors"
      >
        {loading ? <Loader2 size={15} className="animate-spin" /> : status === "failed" ? <RefreshCw size={15} /> : <Cpu size={15} />}
        {loading ? "Starting..." : status === "failed" ? "Retry Parse" : "Parse with AI"}
      </button>
      {error && (
        <div className="flex items-center gap-1.5 text-rose text-xs">
          <AlertCircle size={12} />
          {error}
        </div>
      )}
    </div>
  );
}
