"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ResolveButton({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function resolve() {
    // Optional note the reporter sees in their notifications.
    const message = window.prompt("Message to the reporter (optional) — what was fixed?", "") ?? "";
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/bug-reports/${reportId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim() }),
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
