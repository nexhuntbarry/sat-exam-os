"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SupportComposer from "@/components/support/SupportComposer";
import { formatDateTime, formatShortDateTime } from "@/lib/datetime";
import { StatusBadge, type ReportStatus } from "@/components/ui/StatusBadge";
import { STATUS_LABEL, questionRefLabel, type SupportRow, type SupportStatus } from "@/lib/support-shared";

// Short badge word per status; the full STATUS_LABEL shows on hover.
const BADGE: Record<SupportStatus, ReportStatus> = {
  new: "Received",
  in_progress: "Fixing",
  needs_approval: "Needs approval",
  fixed: "Fixed",
  declined: "Closed",
};

export default function SupportClient({ requests }: { requests: SupportRow[] }) {
  const router = useRouter();
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  // Pick up dev replies without a manual reload.
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(t);
  }, [router]);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-divider bg-surface p-4">
        <h2 className="text-sm font-semibold text-charcoal mb-2">New report</h2>
        <SupportComposer
          url="/api/admin/support"
          placeholder="What happened? Who hit it (student / teacher), on which page or test, and what did they expect?"
          button="Send report"
          onDone={() => router.refresh()}
        />
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-charcoal">Your reports</h2>
        {requests.length === 0 && <p className="text-sm text-soft-mute">No reports yet.</p>}
        {requests.map((r) => (
          <div key={r.id} id={r.id} className="rounded-xl border border-divider bg-surface p-4 space-y-3 scroll-mt-20">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-soft-mute" title={formatDateTime(r.created_at)}>
                {formatShortDateTime(r.created_at)}
              </span>
              <StatusBadge
                kind="report"
                status={BADGE[r.payload.status] ?? "Received"}
                title={STATUS_LABEL[r.payload.status]}
              />
            </div>
            {r.payload.question && (
              <Link
                href={`/admin/questions/${r.payload.question.id}`}
                className="inline-block text-sm text-warm-coral-text hover:underline"
              >
                Question: {questionRefLabel(r.payload.question)}
              </Link>
            )}
            {r.payload.messages.map((m, i) => (
              <div
                key={i}
                className={`rounded-lg px-3 py-2 text-sm ${m.from === "dev" ? "bg-warm-coral/5 border border-warm-coral/15" : "bg-light-bg"}`}
              >
                <div className="text-[11px] text-soft-mute mb-1">
                  {m.from === "dev" ? "Dev team" : "You"} ·{" "}
                  <span title={formatDateTime(m.at)}>{formatShortDateTime(m.at)}</span>
                </div>
                <div className="whitespace-pre-wrap text-charcoal">{m.body}</div>
                {m.screenshots && m.screenshots.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {m.screenshots.map((u) => {
                      const src = `/api/blob-image?u=${encodeURIComponent(u)}`;
                      return (
                        <a key={u} href={src} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={src} alt="Screenshot" className="h-24 rounded-md border border-divider" />
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
            {replyingTo === r.id ? (
              <SupportComposer
                url={`/api/admin/support/${r.id}`}
                placeholder="Add more details, or tell us if it's still happening"
                button="Send"
                onDone={() => {
                  setReplyingTo(null);
                  router.refresh();
                }}
              />
            ) : (
              <button onClick={() => setReplyingTo(r.id)} className="text-sm text-warm-coral-text hover:underline">
                Add a message
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
