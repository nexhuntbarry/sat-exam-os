"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import type { FullLengthSource } from "../full-length-sources";

interface Section {
  key: "rw" | "math";
  sourceId: string | null;
  sourceName: string | null;
  modulesLabel: string;
  timeLabel: string;
}

interface Props {
  testId: string;
  sections: Section[];
  options: FullLengthSource[];
  /**
   * Why re-sync is unavailable: someone started the test, the test is
   * Published, or the feature flag is off for this admin. null = allowed.
   */
  lockReason: "started" | "published" | "flag" | null;
}

// Full-length SAT detail: the two sections with their source tests, and
// "Re-sync from sources" (optionally switching a source). The API refuses
// once anyone has started, and re-checks approval on a Published test.
export default function FullLengthSourcesCard({ testId, sections, options, lockReason }: Props) {
  const locked = lockReason !== null;
  const tf = useTranslations("fullLength");
  const router = useRouter();
  const [picked, setPicked] = useState<Record<"rw" | "math", string>>({ rw: "", math: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function resync() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/tests/${testId}/resync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rwSourceTestId: picked.rw || undefined,
          mathSourceTestId: picked.math || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: j.error ?? tf("saveFailed") });
        return;
      }
      setPicked({ rw: "", math: "" });
      setMessage({ ok: true, text: tf("resyncDone") });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: tf("networkError") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-surface border border-divider rounded-2xl p-5 space-y-4">
      <div className="space-y-0.5">
        <h2 className="text-charcoal font-semibold">{tf("sections")}</h2>
        <p className="text-soft-mute text-xs">{lockReason === "started"
            ? tf("resyncLocked")
            : lockReason === "published"
              ? tf("resyncPublished")
              : lockReason === "flag"
                ? tf("resyncFlagOff")
                : tf("resyncHint")}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {sections.map((s, i) => (
          <div key={s.key} className="rounded-xl border border-divider p-3 space-y-2">
            <p className="text-charcoal text-sm font-medium">
              {i + 1}. {s.key === "rw" ? tf("sectionRw") : tf("sectionMath")}
            </p>
            <p className="text-mid-gray text-xs">
              {tf("sourceLabel", { name: s.sourceName ?? tf("sourceDeleted") })}
            </p>
            <p className="text-soft-mute text-xs">
              {s.modulesLabel} · {s.timeLabel}
            </p>
            {!locked && (
              <select
                aria-label={`${tf("resyncTitle")}: ${s.key === "rw" ? tf("sectionRw") : tf("sectionMath")}`}
                value={picked[s.key]}
                onChange={(e) => setPicked((p) => ({ ...p, [s.key]: e.target.value }))}
                className="w-full bg-surface border border-divider text-charcoal rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-warm-coral/50"
              >
                <option value="">{tf("keepSource")}</option>
                {options
                  .filter((o) => o.section === s.key && o.id !== s.sourceId)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.test_name} ·{" "}
                      {o.unapprovedModules === 0 ? tf("allApproved") : tf("notApproved", { count: o.unapprovedModules })}
                    </option>
                  ))}
              </select>
            )}
          </div>
        ))}
      </div>
      {!locked && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={resync}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-light-bg hover:bg-divider text-charcoal font-semibold text-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={busy ? "animate-spin" : undefined} />
            {busy ? tf("resyncing") : tf("resync")}
          </button>
          {message && (
            <p className={message.ok ? "text-status-success text-xs" : "text-status-error text-xs"}>{message.text}</p>
          )}
        </div>
      )}
    </div>
  );
}
