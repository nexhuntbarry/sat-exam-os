import { computeProgress, tierOf, type Occasion, type DomainTrend } from "@/lib/score-analysis";
import { TrendingUp, TrendingDown, Minus, LineChart } from "lucide-react";

const TIER_STROKE: Record<string, string> = {
  excellent: "var(--color-status-success, #16A34A)",
  solid: "var(--color-status-info, #0284C7)",
  developing: "var(--color-status-warning, #D97706)",
  "needs-work": "var(--color-warm-coral, #F0523D)",
};

// Inline-SVG sparkline of accuracy (0..100) over time. No client JS, no deps.
function Sparkline({ points, stroke, w = 96, h = 28 }: { points: number[]; stroke: string; w?: number; h?: number }) {
  if (points.length === 0) return null;
  const pad = 3;
  const n = points.length;
  const x = (i: number) => (n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
  const y = (v: number) => h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - 2 * pad);
  const d = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <line x1={pad} y1={y(50)} x2={w - pad} y2={y(50)} stroke="var(--color-divider,#E4E4E4)" strokeWidth="1" strokeDasharray="2 3" />
      <path d={d} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(n - 1)} cy={y(last)} r="2.6" fill={stroke} />
    </svg>
  );
}

function TrendBadge({ delta }: { delta: number }) {
  if (delta >= 5)
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-status-success">
        <TrendingUp size={13} /> +{delta}%
      </span>
    );
  if (delta <= -5)
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-warm-coral">
        <TrendingDown size={13} /> {delta}%
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-soft-mute">
      <Minus size={13} /> steady
    </span>
  );
}

function DomainTrendRow({ t }: { t: DomainTrend }) {
  const stroke = TIER_STROKE[tierOf(t.recentPct)] ?? TIER_STROKE.developing;
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="w-44 shrink-0">
        <div className="text-sm font-medium text-charcoal leading-tight">{t.domain}</div>
        <div className="text-xs text-soft-mute">{t.section}</div>
      </div>
      <Sparkline points={t.series.map((p) => p.pct)} stroke={stroke} />
      <div className="flex-1 text-xs text-mid-gray tabular-nums">
        <span className="text-soft-mute">{t.earlyPct}%</span>
        <span className="mx-1 text-faint">→</span>
        <span className="font-semibold text-charcoal">{t.recentPct}%</span>
      </div>
      <div className="w-24 text-right">
        <TrendBadge delta={t.delta} />
      </div>
    </div>
  );
}

/**
 * Progress-over-time report. Pass the student's test occasions (each = one
 * attempt's answer rows + its date), oldest or newest order doesn't matter.
 * Renders an overall trend + per-domain accuracy trends (most-improved first).
 * Server component; no AI, no client JS.
 */
export default function ProgressReport({
  occasions,
  title = "Progress Over Time",
  subtitle,
}: {
  occasions: Occasion[];
  title?: string;
  subtitle?: string;
}) {
  const p = computeProgress(occasions);
  if (!p) {
    return (
      <section className="rounded-2xl border border-divider bg-surface p-5 md:p-6">
        <div className="flex items-center gap-2 mb-2">
          <LineChart size={18} className="text-warm-coral" />
          <h2 className="text-base font-semibold text-charcoal">{title}</h2>
        </div>
        <p className="text-sm text-soft-mute">Complete at least two tests to see how each area is trending over time.</p>
      </section>
    );
  }

  const improved = p.domains.filter((d) => d.trend === "up");
  const declined = p.domains.filter((d) => d.trend === "down");
  const overallStroke = TIER_STROKE[tierOf(p.overall[p.overall.length - 1].pct)] ?? TIER_STROKE.developing;

  return (
    <section className="rounded-2xl border border-divider bg-surface p-5 md:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LineChart size={18} className="text-warm-coral" />
          <div>
            <h2 className="text-base font-semibold text-charcoal">{title}</h2>
            <p className="text-xs text-soft-mute">{subtitle ?? `Across ${p.occasions} tests`}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Sparkline points={p.overall.map((o) => o.pct)} stroke={overallStroke} w={110} h={30} />
          <TrendBadge delta={p.overallDelta} />
        </div>
      </div>

      {/* One-line summary */}
      <div className="rounded-xl bg-light-bg/70 border border-divider p-3.5 text-sm text-mid-gray leading-relaxed">
        {improved.length > 0 ? (
          <>You're improving most in <b className="text-charcoal">{improved[0].domain}</b> ({improved[0].earlyPct}% → {improved[0].recentPct}%).{" "}</>
        ) : (
          <>No area has jumped yet — keep practicing to build a trend.{" "}</>
        )}
        {declined.length > 0 && (
          <>Watch <b className="text-charcoal">{declined[declined.length - 1].domain}</b>, which has slipped recently.</>
        )}
      </div>

      {/* Per-domain trends, most-improved first */}
      <div className="divide-y divide-divider/60">
        {p.domains.map((t) => (
          <DomainTrendRow key={`${t.section}-${t.domain}`} t={t} />
        ))}
      </div>
    </section>
  );
}
