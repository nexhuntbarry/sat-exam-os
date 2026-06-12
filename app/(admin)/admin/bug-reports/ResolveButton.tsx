"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ResolveButton({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function resolve() {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/bug-reports/${reportId}/resolve`, {
        method: "POST",
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={resolve}
      disabled={busy}
      className="px-2 py-1 rounded-md text-xs bg-warm-amber/15 hover:bg-warm-amber/25 text-warm-amber font-medium transition-colors disabled:opacity-50"
    >
      {busy ? "..." : "Mark resolved"}
    </button>
  );
}
