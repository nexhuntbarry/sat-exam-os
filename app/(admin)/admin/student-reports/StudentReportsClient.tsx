"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDateTime } from "@/lib/datetime";
import {
  STUDENT_REPORT_CONTEXT_LABEL,
  STUDENT_REPORT_KIND_LABEL,
  type StudentReportStatus,
} from "@/lib/student-reports-shared";
import type { StudentReportView } from "@/lib/student-reports";

const PILL: Record<StudentReportStatus, string> = {
  new: "bg-status-warning/15 text-status-warning",
  forwarded: "bg-warm-coral/15 text-warm-coral-text",
  dismissed: "bg-light-bg text-mid-gray",
};
const STATUS_LABEL: Record<StudentReportStatus, string> = {
  new: "New",
  forwarded: "Forwarded to dev",
  dismissed: "Dismissed",
};

export function ReportingToggle({ initialEnabled, canChange }: { initialEnabled: boolean; canChange: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function flip() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/student-reports/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setEnabled(data.enabled === true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-divider bg-surface p-4 flex flex-wrap items-center gap-3">
      <div className="flex-1 min-w-[16rem]">
        <div className="text-sm font-semibold text-charcoal">
          Student reporting is {enabled ? "ON" : "OFF"}
        </div>
        <p className="text-xs text-soft-mute mt-0.5">
          When on, students see a small &ldquo;Report a problem&rdquo; button on each question while taking a test
          and on their results and class review pages. It never pauses the timer or changes answers or scores.
          A test that is already open picks up the change when the page next loads.
        </p>
        {error && <p className="text-xs text-status-error mt-1">{error}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Student reporting"
        onClick={flip}
        disabled={busy || !canChange}
        title={canChange ? undefined : "QA accounts can't change global settings"}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          enabled ? "bg-warm-coral" : "bg-divider"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            enabled ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function ReportCard({ r }: { r: StudentReportView }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [forwarding, setForwarding] = useState(false);
  const [adminNote, setAdminNote] = useState("");
  const p = r.payload;

  async function act(action: "forward" | "dismiss" | "reopen") {
    setBusy(action);
    setError("");
    try {
      const res = await fetch(`/api/admin/student-reports/${r.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, adminNote: action === "forward" ? adminNote : undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setForwarding(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const qLabel = p.question_number != null ? `Q${p.question_number}` : "Question";

  return (
    <div id={r.id} className="rounded-xl border border-divider bg-surface p-4 space-y-2 scroll-mt-20">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-charcoal">{STUDENT_REPORT_KIND_LABEL[p.kind] ?? p.kind}</span>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${PILL[p.status] ?? PILL.new}`}>
          {STATUS_LABEL[p.status] ?? p.status}
        </span>
        <span className="ml-auto text-xs text-soft-mute">{formatDateTime(r.created_at)}</span>
      </div>
      <div className="text-sm text-mid-gray space-y-0.5">
        <div>
          <span className="text-charcoal font-medium">{r.test_name}</span> · {r.module_name} ·{" "}
          <Link href={`/admin/questions/${p.question_id}`} className="text-warm-coral-text hover:underline">
            {qLabel}
          </Link>
          {p.display_number != null && p.display_number !== p.question_number && (
            <span className="text-soft-mute"> (#{p.display_number} on the student&apos;s screen)</span>
          )}
        </div>
        <div>
          {r.student_name}
          {r.student_email && <span className="text-soft-mute"> · {r.student_email}</span>} ·{" "}
          {STUDENT_REPORT_CONTEXT_LABEL[p.context] ?? p.context}
        </div>
      </div>
      {p.note ? (
        <div className="rounded-lg bg-light-bg px-3 py-2 text-sm text-charcoal whitespace-pre-wrap">{p.note}</div>
      ) : (
        <div className="text-xs text-soft-mute italic">No note</div>
      )}
      {p.status !== "new" && p.handled_by_name && (
        <div className="text-xs text-soft-mute">
          {STATUS_LABEL[p.status]} by {p.handled_by_name}
          {p.handled_at ? ` · ${formatDateTime(p.handled_at)}` : ""}
          {p.forwarded_request_id && (
            <>
              {" · "}
              <Link href={`/admin/support#${p.forwarded_request_id}`} className="text-warm-coral-text hover:underline">
                View dev thread
              </Link>
            </>
          )}
        </div>
      )}

      {forwarding ? (
        <div className="space-y-2">
          <textarea
            value={adminNote}
            onChange={(e) => setAdminNote(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Optional note for the dev team (what you checked, what you think is wrong)"
            className="w-full rounded-lg border border-divider bg-surface px-3 py-2 text-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-warm-coral/40"
          />
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setForwarding(false)}
              className="px-3 py-1.5 rounded-lg text-sm text-mid-gray hover:text-charcoal"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => act("forward")}
              disabled={busy !== null}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-warm-coral text-white hover:bg-warm-coral-dark disabled:opacity-50"
            >
              {busy === "forward" ? "Forwarding..." : "Send to dev"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 justify-end">
          {(p.status === "new" || p.status === "dismissed") && (
            <button
              type="button"
              onClick={() => setForwarding(true)}
              disabled={busy !== null}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-warm-coral text-white hover:bg-warm-coral-dark disabled:opacity-50"
            >
              Forward to dev
            </button>
          )}
          {p.status === "new" && (
            <button
              type="button"
              onClick={() => act("dismiss")}
              disabled={busy !== null}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-light-bg text-charcoal hover:bg-divider disabled:opacity-50"
            >
              {busy === "dismiss" ? "Dismissing..." : "Dismiss"}
            </button>
          )}
          {p.status === "dismissed" && (
            <button
              type="button"
              onClick={() => act("reopen")}
              disabled={busy !== null}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-light-bg text-charcoal hover:bg-divider disabled:opacity-50"
            >
              {busy === "reopen" ? "Reopening..." : "Reopen"}
            </button>
          )}
        </div>
      )}
      {error && <p className="text-sm text-status-error">{error}</p>}
    </div>
  );
}

export default function StudentReportsClient({ reports }: { reports: StudentReportView[] }) {
  if (reports.length === 0) {
    return <p className="text-sm text-soft-mute">No reports here.</p>;
  }
  return (
    <div className="space-y-3">
      {reports.map((r) => (
        <ReportCard key={r.id} r={r} />
      ))}
    </div>
  );
}
