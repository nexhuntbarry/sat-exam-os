"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { RowButton } from "@/components/ui/data-table";

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
    <RowButton
      label={busy ? "Resolving…" : "Mark resolved"}
      icon={<Check size={13} />}
      disabled={busy}
      onClick={resolve}
    />
  );
}
