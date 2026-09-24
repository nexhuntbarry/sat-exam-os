import { computeBreakdown, tierOf, TIER_LABEL, type Occasion } from "@/lib/score-analysis";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import { ChevronRight, ClipboardList } from "lucide-react";

const TIER_SOFT: Record<string, string> = {
  excellent: "bg-status-success/12 text-status-success",
  solid: "bg-status-info/12 text-status-info",
  developing: "bg-status-warning/12 text-status-warning",
  "needs-work": "bg-warm-coral/12 text-warm-coral",
};

function fmtDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * One expandable score report per test the student took (newest first). Each
 * row summarizes that attempt's overall %; expanding shows the full per-domain
 * breakdown for THAT test (not the aggregate). No AI.
 */
export default function PerTestBreakdown({
  occasions,
  title = "Score Report — By Test",
}: {
  occasions: Occasion[];
  title?: string;
}) {
  const items = occasions
    .filter((o) => o.rows.length > 0)
    .map((o) => ({ o, b: computeBreakdown(o.rows) }))
    .sort((a, b) => b.o.date.localeCompare(a.o.date));
  if (items.length === 0) return null;

  return (
    <section className="rounded-2xl border border-divider bg-surface p-5 md:p-6">
      <div className="flex items-center gap-2 mb-4">
        <ClipboardList size={18} className="text-warm-coral" />
        <h2 className="text-base font-semibold text-charcoal">{title}</h2>
      </div>
      <div className="space-y-2">
        {items.map(({ o, b }, i) => {
          const tier = tierOf(b.pct);
          return (
            <details key={`${o.label}-${o.date}-${i}`} className="group rounded-xl border border-divider overflow-hidden">
              <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer list-none select-none hover:bg-light-bg/60">
                <ChevronRight size={15} className="text-soft-mute transition-transform group-open:rotate-90 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-charcoal truncate">{o.label ?? "Test"}</div>
                  <div className="text-xs text-soft-mute">{fmtDate(o.date)} · {b.correct}/{b.total} correct</div>
                </div>
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${TIER_SOFT[tier]}`}>
                  {b.pct}% · {TIER_LABEL[tier]}
                </span>
              </summary>
              <div className="px-3 pb-3 pt-1 bg-light-bg/30">
                <ScoreBreakdown rows={o.rows} title="Breakdown for this test" />
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
