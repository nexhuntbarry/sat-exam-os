"use client";

import { useId } from "react";
import { CalendarClock } from "lucide-react";
import { formatShortDateTime } from "@/lib/datetime";
import { nyLocalToIso, plural } from "@/lib/test-assign-shared";

// Optional "Publish at" for the Draft tests in a bulk assign (ticket
// b271dd38). The value is New York wall-clock time whatever the admin's own
// zone (nyLocalToIso); empty keeps the Drafts as Drafts.
export default function PublishAtField({
  draftCount,
  value,
  onChange,
}: {
  draftCount: number;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  if (draftCount === 0) return null;
  const iso = nyLocalToIso(value);
  return (
    <div className="rounded-xl border border-divider bg-light-bg/60 px-3 py-2.5 space-y-1.5">
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-semibold text-charcoal">
        <CalendarClock size={13} />
        Publish at <span className="font-normal text-soft-mute">(optional · New York time)</span>
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-surface border border-divider text-sm text-charcoal focus:outline-none focus:border-warm-coral/50"
        />
        {value && (
          <button type="button" onClick={() => onChange("")} className="text-xs text-soft-mute hover:text-charcoal">
            Clear
          </button>
        )}
      </div>
      <p className="text-[11px] leading-snug text-soft-mute">
        {iso
          ? `${plural(draftCount, "Draft test")} will publish ${formatShortDateTime(iso)} ET if it passes the publish check (all questions Approved). Students see it from then.`
          : `${plural(draftCount, "selected test is a Draft", "selected tests are Drafts")}: students can't see a Draft. Leave this empty to keep it Draft.`}
      </p>
    </div>
  );
}
