import { computeBreakdown, narrative, tierOf, TIER_LABEL, type AnswerRow, type Tier, type DomainStat } from "@/lib/score-analysis";
import { Sparkles } from "lucide-react";

const TIER_BAR: Record<Tier, string> = {
  excellent: "bg-status-success",
  solid: "bg-status-info",
  developing: "bg-status-warning",
  "needs-work": "bg-warm-coral",
};
const TIER_TEXT: Record<Tier, string> = {
  excellent: "text-status-success",
  solid: "text-status-info",
  developing: "text-status-warning",
  "needs-work": "text-warm-coral",
};
const TIER_SOFT: Record<Tier, string> = {
  excellent: "bg-status-success/12 text-status-success",
  solid: "bg-status-info/12 text-status-info",
  developing: "bg-status-warning/12 text-status-warning",
  "needs-work": "bg-warm-coral/12 text-warm-coral",
};

function DomainRow({ d, tag }: { d: DomainStat; tag?: "strength" | "focus" }) {
  const tier = tierOf(d.pct);
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="w-40 shrink-0">
        <div className="text-sm font-medium text-charcoal leading-tight">{d.domain}</div>
        <div className="text-xs text-soft-mute">
          {d.correct}/{d.total} correct
        </div>
      </div>
      <div className="flex-1 h-2.5 rounded-full bg-light-bg overflow-hidden">
        <div className={`h-full rounded-full ${TIER_BAR[tier]}`} style={{ width: `${Math.max(d.pct, 3)}%` }} />
      </div>
      <div className={`w-10 text-right text-sm font-semibold tabular-nums ${TIER_TEXT[tier]}`}>{d.pct}%</div>
      <div className="w-16 shrink-0">
        {tag === "strength" && (
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-status-success/12 text-status-success">Strength</span>
        )}
        {tag === "focus" && (
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-warm-coral/12 text-warm-coral">Focus</span>
        )}
      </div>
    </div>
  );
}

/**
 * Student-facing strengths/weaknesses breakdown. Pass the graded answer rows
 * (is_correct + the question's section & domain). Renders a written report
 * (template-generated, no AI) plus per-domain accuracy bars grouped by section.
 */
export default function ScoreBreakdown({
  rows,
  title = "Score Breakdown by Area",
}: {
  rows: AnswerRow[];
  title?: string;
}) {
  const b = computeBreakdown(rows);
  if (!b.domains.length) return null;

  const report = narrative(b);
  const best = b.domains[0];
  const worst = b.domains[b.domains.length - 1];
  const strengthDomain = best.pct >= 70 ? best.domain : null;
  const focusDomain = worst.pct < 70 && worst.domain !== strengthDomain ? worst.domain : null;

  return (
    <section className="rounded-2xl border border-divider bg-surface p-5 md:p-6 space-y-5">
      <div className="flex items-center gap-2">
        <Sparkles size={18} className="text-warm-coral" />
        <h2 className="text-base font-semibold text-charcoal">{title}</h2>
      </div>

      {/* Written report */}
      {report.length > 0 && (
        <div className="rounded-xl bg-light-bg/70 border border-divider p-4 space-y-2">
          {report.map((p, i) => (
            <p key={i} className={i === 0 ? "text-sm text-charcoal font-medium leading-relaxed" : "text-sm text-mid-gray leading-relaxed"}>
              {p}
            </p>
          ))}
        </div>
      )}

      {/* Per-section domain bars */}
      <div className="space-y-5">
        {b.bySection.map((sec) => (
          <div key={sec.section}>
            <div className="flex items-baseline justify-between mb-1">
              <h3 className="text-sm font-semibold text-charcoal">{sec.section}</h3>
              <span className={`text-xs font-medium ${TIER_SOFT[tierOf(sec.pct)]} px-2 py-0.5 rounded-full`}>
                {sec.pct}% · {TIER_LABEL[tierOf(sec.pct)]}
              </span>
            </div>
            <div className="divide-y divide-divider/60">
              {sec.domains.map((d) => (
                <DomainRow
                  key={d.domain}
                  d={d}
                  tag={d.domain === strengthDomain ? "strength" : d.domain === focusDomain ? "focus" : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
