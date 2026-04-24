"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Cpu } from "lucide-react";

export default function ModuleParseButton({ moduleId }: { moduleId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleParse() {
    setLoading(true);
    try {
      await fetch(`/api/admin/modules/${moduleId}/parse`, { method: "POST" });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleParse}
      disabled={loading}
      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-electric-blue hover:bg-electric-blue/90 text-white font-semibold text-sm shrink-0 disabled:opacity-60 transition-colors"
    >
      <Cpu size={15} />
      {loading ? "Queuing..." : "Parse with AI"}
    </button>
  );
}
