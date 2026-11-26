import type { Occasion } from "@/lib/score-analysis";
import { placeLabels } from "@/lib/chart-labels";
import { SUBJECT_LINE_COLORS } from "@/lib/subject-colors";
import { TrendingUp } from "lucide-react";

// SAT score progression chart: Total (400–1600), Math (200–800), and R&W
// (200–800) as three overlapping lines on a single auto-ranged y axis.
// All three are shown when full-length SAT data is available; for a teacher
// who teaches only one subject, only that section's line is shown (the
// occasions passed in are already filtered to their subject(s)).
// Inline SVG, no client JS, no external chart deps.

// Math / R&W use the subject colours (lib/subject-colors.ts, same as
// SubjectTag); Total stays green so it reads apart from both.
const COLORS = {
  total: "var(--color-status-success, #059669)",
  math:  SUBJECT_LINE_COLORS.math,
  rw:    SUBJECT_LINE_COLORS.rw,
} as const;

const SERIES_LABEL: Record<keyof typeof COLORS, string> = {
  total: "Total",
  math:  "Math",
  rw:    "R&W",
};

/** Compute grid tick values in [yMin, yMax] with a readable step. */
function niceTicks(yMin: number, yMax: number): number[] {
  const range = yMax - yMin;
  const step = range <= 500 ? 100 : range <= 800 ? 200 : 400;
  const ticks: number[] = [];
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) ticks.push(v);
  return ticks;
}

export default function ScoreProgressChart({
  occasions,
  height = 240,
}: {
  occasions: Occasion[];
  height?: number;
}) {
  // Keep only occasions with a section score and a date.
  const scored = occasions
    .filter((o) => o.scaledScore != null && o.section && o.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (scored.length < 2) return null;

  // ── Build per-series point arrays ─────────────────────────────────────
  const mathPts = scored
    .filter((o) => o.section === "Math")
    .map((o) => ({ date: o.date, score: o.scaledScore! }));

  const rwPts = scored
    .filter((o) => o.section === "Reading & Writing")
    .map((o) => ({ date: o.date, score: o.scaledScore! }));

  // Total = sum of Math + R&W for the same full-length SAT attempt.
  // Two occasions share a testKey when they belong to the same FL attempt.
  // For plain section tests testKey is their own session id, so they never pair.
  const totalPts: { date: string; score: number }[] = (() => {
    const byKey = new Map<string, { rw?: number; math?: number; date: string }>();
    for (const o of scored) {
      if (!o.testKey) continue;
      const e = byKey.get(o.testKey) ?? { date: o.date };
      if (o.section === "Reading & Writing") e.rw = o.scaledScore!;
      if (o.section === "Math") e.math = o.scaledScore!;
      // Use the latest date in the pair (Math is submitted last).
      if (o.date > e.date) e.date = o.date;
      byKey.set(o.testKey, e);
    }
    return Array.from(byKey.values())
      .filter((e) => e.rw != null && e.math != null)
      .map((e) => ({ date: e.date, score: e.rw! + e.math! }))
      .sort((a, b) => a.date.localeCompare(b.date));
  })();

  const showMath  = mathPts.length > 0;
  const showRW    = rwPts.length > 0;
  const showTotal = totalPts.length > 0;

  if (!showMath && !showRW) return null;

  // ── Y scale ───────────────────────────────────────────────────────────
  // Single shared axis: auto-ranged over all three series with padding so
  // labels above the topmost point are never clipped. Math/R&W (200–800)
  // and Total (400–1600) naturally separate because Total ≈ Math + R&W.
  const allScores = [
    ...mathPts.map((p) => p.score),
    ...rwPts.map((p) => p.score),
    ...totalPts.map((p) => p.score),
  ];
  const dataMin = Math.min(...allScores);
  const dataMax = Math.max(...allScores);
  const pad = Math.max(50, Math.round(((dataMax - dataMin) * 0.12) / 50) * 50);
  const yMin = Math.max(100, Math.floor((dataMin - pad) / 50) * 50);
  const yMax = Math.min(1700, Math.ceil((dataMax + pad) / 50) * 50);

  // ── Layout ────────────────────────────────────────────────────────────
  const W = 680, H = height;
  // padT/padB are generous: above-labels rise ~18 px above the topmost dot;
  // up to two stacked below-labels descend ~32 px below the bottommost dot.
  const padL = 44, padR = 20, padT = 28, padB = 42;

  // All unique x positions across every series, sorted chronologically.
  const allDates = [
    ...new Set([
      ...mathPts.map((p) => p.date),
      ...rwPts.map((p) => p.date),
      ...totalPts.map((p) => p.date),
    ]),
  ].sort();
  const n = allDates.length;

  // Inset the first and last data points so their labels don't collide with
  // the y-axis tick labels on the left (and have a tidy right margin).
  // A label centered at padL would have its left edge ~14 px into the tick
  // area; with xInset=20 the left edge clears the tick column by ~6 px.
  const xInset = 20;
  const xOf = (date: string): number => {
    const i = allDates.indexOf(date);
    if (n <= 1) return padL + (W - padL - padR) / 2;
    const dataWidth = W - padL - padR - 2 * xInset;
    return padL + xInset + (i * dataWidth) / (n - 1);
  };

  const yOf = (s: number): number =>
    padT +
    (1 - (Math.max(yMin, Math.min(yMax, s)) - yMin) / (yMax - yMin)) *
      (H - padT - padB);

  const ticks = niceTicks(yMin, yMax);

  // ── Label collision avoidance ─────────────────────────────────────────
  type Lp = { id: string; x: number; dotY: number; score: number; fill: string };
  const labelPoints: Lp[] = [];

  // Insert in z-order: Total first (highest on chart → plotted last = on top).
  if (showTotal)
    totalPts.forEach((p, i) =>
      labelPoints.push({
        id: `total-${i}`,
        x: xOf(p.date),
        dotY: yOf(p.score),
        score: p.score,
        fill: COLORS.total,
      }),
    );
  if (showMath)
    mathPts.forEach((p, i) =>
      labelPoints.push({
        id: `math-${i}`,
        x: xOf(p.date),
        dotY: yOf(p.score),
        score: p.score,
        fill: COLORS.math,
      }),
    );
  if (showRW)
    rwPts.forEach((p, i) =>
      labelPoints.push({
        id: `rw-${i}`,
        x: xOf(p.date),
        dotY: yOf(p.score),
        score: p.score,
        fill: COLORS.rw,
      }),
    );

  const labelY = placeLabels(
    labelPoints.map((p) => ({ id: p.id, x: p.x, dotY: p.dotY })),
    // textHeight for fontSize 11 bold; dotRadius matches the <circle r="3.5">
    { textHeight: 12, dotRadius: 3.5, gap: 2, labelGap: 2 },
  );

  const seriesConfig: {
    key: keyof typeof COLORS;
    pts: { date: string; score: number }[];
    show: boolean;
  }[] = [
    { key: "total", pts: totalPts, show: showTotal },
    { key: "math",  pts: mathPts,  show: showMath  },
    { key: "rw",    pts: rwPts,    show: showRW    },
  ];

  return (
    <div className="rounded-2xl border border-divider bg-surface p-5 md:p-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <TrendingUp size={18} className="text-warm-coral-text" />
          <h2 className="text-base font-semibold text-charcoal">SAT Score Progression</h2>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {seriesConfig
            .filter((s) => s.show)
            .map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5 text-mid-gray">
                <span
                  className="w-3 h-0.5 rounded"
                  style={{ background: COLORS[s.key] }}
                />
                {SERIES_LABEL[s.key]}
              </span>
            ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="max-w-full"
        >
          {/* Grid lines + y-axis labels */}
          {ticks.map((g) => (
            <g key={g}>
              <line
                x1={padL}
                y1={yOf(g)}
                x2={W - padR}
                y2={yOf(g)}
                stroke="var(--color-divider,#E4E4E4)"
                strokeWidth="1"
                strokeDasharray="2 3"
              />
              <text
                x={padL - 6}
                y={yOf(g) + 4}
                textAnchor="end"
                fontSize="10"
                fill="var(--color-soft-mute,#9C9999)"
              >
                {g}
              </text>
            </g>
          ))}

          {/* Lines (only for series with ≥2 points; dots show for 1-point series) */}
          {seriesConfig
            .filter((s) => s.show && s.pts.length >= 2)
            .map(({ key, pts }) => {
              const color = COLORS[key];
              const d = pts
                .map(
                  (p, i) =>
                    `${i === 0 ? "M" : "L"}${xOf(p.date).toFixed(1)},${yOf(p.score).toFixed(1)}`,
                )
                .join(" ");
              return (
                <path
                  key={key}
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
            })}

          {/* Dots and score labels (all points, with collision-aware label y) */}
          {labelPoints.map((lp) => (
            <g key={lp.id}>
              <circle cx={lp.x} cy={lp.dotY} r="3.5" fill={lp.fill} />
              <text
                x={lp.x}
                y={labelY.get(lp.id) ?? lp.dotY - 10}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill={lp.fill}
              >
                {lp.score}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
