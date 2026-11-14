"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { clsx } from "clsx";
import { formatShortDateTime } from "@/lib/datetime";

// A Draft's scheduled publish (tests.publish_at, ticket b271dd38): "Publishes
// 11/20 4:00 PM" (or "Scheduled publish failed", the reason on hover) with an
// Unschedule button (PATCH /api/admin/tests/[id] { publishAt: null }). Tests
// list status cell and the test page header.
export default function ScheduleNote({
  testId,
  publishAt,
  error,
  className,
}: {
  testId: string;
  publishAt: string;
  error: string | null;
  className?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function unschedule() {
    if (busy || !window.confirm("Remove the scheduled publish? The test stays a Draft.")) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/admin/tests/${testId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publishAt: null }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(j.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setMsg("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={clsx("inline-flex flex-wrap items-center gap-x-1.5 text-[11px]", className)}>
      <span
        className={clsx("inline-flex items-center gap-1 whitespace-nowrap", error ? "text-status-error" : "text-soft-mute")}
        title={error ?? "Publishes automatically (New York time) if it passes the publish check"}
      >
        <CalendarClock size={11} />
        {error ? "Scheduled publish failed" : `Publishes ${formatShortDateTime(publishAt)}`}
      </span>
      <button
        type="button"
        onClick={unschedule}
        disabled={busy}
        className="text-warm-coral-text hover:underline disabled:opacity-50"
      >
        {busy ? "Removing…" : "Unschedule"}
      </button>
      {msg && <span className="text-status-error">{msg}</span>}
    </span>
  );
}
