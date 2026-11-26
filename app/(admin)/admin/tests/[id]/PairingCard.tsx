"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2 } from "lucide-react";

// "Paired with" on the admin test page (lib/test-pairing, ticket f7276162):
// which test of the other section makes one R&W + Math set (one total) with
// this test on the reports, charts and the class Scores grid. Automatic by
// default (same set name, else same day per student); the admin can pick a
// test or set "no pair". POST /api/admin/tests/[id]/pairing keeps it
// symmetric. Display only: scores are never changed.

type Option = { id: string; name: string };

export default function PairingCard({
  testId,
  otherSection,
  current,
  autoPartner,
  options,
  pending = false,
}: {
  testId: string;
  /** "Math" / "R&W": the section the partner must be. */
  otherSection: string;
  /** The stored override: automatic, explicitly none, or a partner. */
  current: { mode: "auto" } | { mode: "none" } | { mode: "pair"; partner: Option | null };
  /** The automatic partner by set name (null: none; sets then fall back to the same day). */
  autoPartner: Option | null;
  /** Tests of the other section to pick from. */
  options: Option[];
  /** Migration 0036 not applied yet: show the automatic partner, editing disabled. */
  pending?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(pending ? "Database update pending: the override can be set once migration 0036 is applied." : null);
  const [, startTransition] = useTransition();
  const value = current.mode === "pair" ? `pair:${current.partner?.id ?? ""}` : current.mode;

  async function save(v: string) {
    setBusy(true);
    setError(null);
    const body = v.startsWith("pair:") ? { mode: "pair", partnerId: v.slice(5) } : { mode: v };
    try {
      const res = await fetch(`/api/admin/tests/${testId}/pairing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Failed to update the pairing");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Failed to update the pairing");
    } finally {
      setBusy(false);
    }
  }

  const shown =
    current.mode === "pair"
      ? current.partner?.name ?? "(deleted test)"
      : current.mode === "none"
        ? "No pair (set by an admin)"
        : autoPartner
          ? `${autoPartner.name} (automatic)`
          : "Automatic: same-day " + otherSection + " test, per student";

  return (
    <div className="bg-surface border border-divider rounded-2xl p-5 space-y-2" data-pairing={current.mode}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-charcoal font-semibold text-sm">
            <Link2 size={15} className="shrink-0 text-warm-amber" />
            Paired with: <span className="font-medium break-words">{shown}</span>
          </div>
          <p className="text-soft-mute text-xs mt-0.5">
            The R&amp;W and Math tests of one set give one total on student reports, charts and the class Scores grid.
            Automatic = the {otherSection} test with the same name (subject words left out), else the {otherSection} test the
            student finished the same day. Scores don&rsquo;t change.
          </p>
          {error && (
            <p className="text-status-error text-xs mt-1" role="alert">
              {error}
            </p>
          )}
        </div>
        <label className="shrink-0 text-xs text-mid-gray">
          <span className="sr-only">Paired with</span>
          <select
            value={value}
            disabled={busy || pending}
            onChange={(e) => save(e.target.value)}
            className="max-w-[18rem] rounded-lg border border-divider bg-surface px-2 py-1.5 text-xs text-charcoal disabled:opacity-50"
          >
            <option value="auto">{autoPartner ? `Automatic (${autoPartner.name})` : "Automatic"}</option>
            <option value="none">No pair</option>
            {current.mode === "pair" && !current.partner && <option value={value}>(deleted test)</option>}
            {options.map((o) => (
              <option key={o.id} value={`pair:${o.id}`}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
