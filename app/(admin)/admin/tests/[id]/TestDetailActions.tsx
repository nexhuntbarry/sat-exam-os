"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Lock, Copy } from "lucide-react";

interface Props {
  testId: string;
  status: string;
}

export default function TestDetailActions({ testId, status }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  async function handleAction(action: "publish" | "close") {
    setLoading(action);
    try {
      const res = await fetch(`/api/admin/tests/${testId}/${action}`, { method: "POST" });
      if (res.ok) router.refresh();
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      {status === "Draft" && (
        <button
          disabled={loading === "publish"}
          onClick={() => handleAction("publish")}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-lime-green hover:bg-lime-green/90 text-deep-navy font-semibold text-sm transition-colors disabled:opacity-50"
        >
          <Send size={14} />
          {loading === "publish" ? "Publishing..." : "Publish"}
        </button>
      )}
      {status === "Published" && (
        <button
          disabled={loading === "close"}
          onClick={() => handleAction("close")}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-rose/20 hover:bg-rose/30 text-rose font-semibold text-sm transition-colors disabled:opacity-50"
        >
          <Lock size={14} />
          {loading === "close" ? "Closing..." : "Close Test"}
        </button>
      )}
    </div>
  );
}
