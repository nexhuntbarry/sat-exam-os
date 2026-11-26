import type { Occasion } from "@/lib/score-analysis";
import { placeLabels, type LabelSegment } from "@/lib/chart-labels";
import { SUBJECT_LINE_COLORS } from "@/lib/subject-colors";
import { buildAssessments, setLabels, sectionDates } from "@/lib/one-page-report";
import { formatShortDate } from "@/lib/datetime";
import { TrendingUp } from "lucide-react";

// SAT score progression chart: Total (400–1600), Math (200–800), and R&W
// (200–800) as three lines on a single auto-ranged y axis. One point per
// assessment, as on the one-page parent report (lib/one-page-report
// buildAssessments): a full-length SAT, or a set of section tests
// (lib/test-pairing: admin override, same set name, else same New York
// day). Total = R&W + Math of the set; a set with one section finished has
// no total. For a teacher who teaches only one subject, only that section's
// line is shown (the occasions passed in are already filtered to their
// subject(s), so nothing pairs). Estimated (Custom test) scores are left
// out, as on the parent report. Inline SVG, no client JS, no chart deps.

// Colours shared with SubjectTag and the parent report (lib/subject-colors.ts).
const COLORS = {
  total: SUBJECT_LINE_COLORS.total,
  math: SUBJECT_LINE_COLORS.math,
  rw: SUBJECT_LINE_COLORS.rw,
} as const;
type SeriesKey = keyof typeof COLORS;

const SERIES_LABEL: Record<SeriesKey, string> = {
  total: "Total",
  math: "Math",
  rw: "R&W",
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
  height = 270,
}: {
  occasions: Occasion[];
  height?: number;
}) {
  const assessments = buildAssessments(occasions);
  if (assessments.length < 2) return null;
  const labels = setLabels(assessments);

  // ── Per-series points (index = the assessment's column) ───────────────
  type Pt = { i: number; score: number };
  const pts: Record<SeriesKey, Pt[]> = { total: [], math: [], rw: [] };
  assessments.forEach((a, i) => {
    if (a.total != null) pts.total.push({ i, score: a.total });
    if (a.math) pts.math.push({ i, score: a.math.sat });
    if (a.rw) pts.rw.push({ i, score: a.rw.sat });
  });
  const show: Record<SeriesKey, boolean> = {
    total: pts.total.length > 0,
    math: pts.math.length > 0,
    rw: pts.rw.length > 0,
  };
  if (!show.math && !show.rw) return null;

  // ── Y scale ───────────────────────────────────────────────────────────
  // Single shared axis, padded so labels above the topmost point are never
  // clipped. Math/R&W (200–800) and Total (400–1600) naturally separate.
  const allScores = [...pts.total, ...pts.math, ...pts.rw].map((p) => p.score);
  const dataMin = Math.min(...allScores);
  const dataMax = Math.max(...allScores);
  const pad = Math.max(50, Math.round(((dataMax - dataMin) * 0.12) / 50) * 50);
  const yMin = Math.max(100, Math.floor((dataMin - pad) / 50) * 50);
  const yMax = Math.min(1700, Math.ceil((dataMax + pad) / 50) * 50);

  // ── Layout ────────────────────────────────────────────────────────────
  const W = 680, H = height;
  // padT: above-labels rise ~18 px over the topmost dot; padB: up to two
  // stacked below-labels (~32 px) plus the two x-axis lines (set, dates).
  const padL = 44, padR = 20, padT = 28, padB = 70;
  const n = assessments.length;
  // Inset the end points so their labels clear the y-axis tick labels.
  const xInset = 24;
  const xOf = (i: number): number =>
    n <= 1 ? padL + (W - padL - padR) / 2 : padL + xInset + (i * (W - padL - padR - 2 * xInset)) / (n - 1);
  const yOf = (s: number): number =>
    padT + (1 - (Math.max(yMin, Math.min(yMax, s)) - yMin) / (yMax - yMin)) * (H - padT - padB);
  const ticks = niceTicks(yMin, yMax);

  // x-axis text, cut to the column width (~6 px a character at 10 px).
  const colWidth = n > 1 ? (W - padL - padR - 2 * xInset) / (n - 1) : W - padL - padR;
  const maxChars = Math.max(4, Math.floor(colWidth / 6));
  const fit = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars - 1).trimEnd()}…` : s);
  const dateLine = (i: number) => sectionDates(assessments[i]).map((d) => formatShortDate(d)).join(" · ");

  // ── Labels: split above/below at a column, off the lines ──────────────
  const order: SeriesKey[] = ["total", "math", "rw"];
  const segments: LabelSegment[] = order.flatMap((k) =>
    pts[k].slice(1).map((p, j) => ({
      x1: xOf(pts[k][j].i),
      y1: yOf(pts[k][j].score),
      x2: xOf(p.i),
      y2: yOf(p.score),
    })),
  );
  const labelPoints = order.flatMap((k) =>
    pts[k].map((p) => ({ id: `${k}-${p.i}`, x: xOf(p.i), dotY: yOf(p.score), score: p.score, fill: COLORS[k], labelFill: k === "total" ? SUBJECT_LINE_COLORS.totalLabel : COLORS[k], text: String(p.score) })),
  );
  const labelY = placeLabels(
    labelPoints,
    // textHeight for fontSize 11 bold; dotRadius matches the <circle r="3.5">
    { textHeight: 12, dotRadius: 3.5, gap: 2, labelGap: 2 },
    { segments },
  );

  return (
    <div className="rounded-2xl border border-divider bg-surface p-5 md:p-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <TrendingUp size={18} className="text-warm-coral-text" />
          <h2 className="text-base font-semibold text-charcoal">SAT Score Progression</h2>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {order
            .filter((k) => show[k])
            .map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5 text-mid-gray">
                <span className={k === "total" ? "w-3 h-1 rounded" : "w-3 h-0.5 rounded"} style={{ background: COLORS[k] }} />
                {SERIES_LABEL[k]}
              </span>
            ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full">
          {/* Grid lines + y-axis labels */}
          {ticks.map((g) => (
            <g key={g}>
              <line x1={padL} y1={yOf(g)} x2={W - padR} y2={yOf(g)} stroke="var(--color-divider,#E4E4E4)" strokeWidth="1" strokeDasharray="2 3" />
              <text x={padL - 6} y={yOf(g) + 4} textAnchor="end" fontSize="10" fill="var(--color-soft-mute,#9C9999)">
                {g}
              </text>
            </g>
          ))}

          {/* Lines (a series with one point shows its dot only) */}
          {order
            .filter((k) => pts[k].length >= 2)
            .map((k) => (
              <path
                key={k}
                d={pts[k].map((p, j) => `${j === 0 ? "M" : "L"}${xOf(p.i).toFixed(1)},${yOf(p.score).toFixed(1)}`).join(" ")}
                fill="none"
                stroke={COLORS[k]}
                strokeWidth={k === "total" ? 3 : 2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}

          {/* Dots, then the score labels on top with a white halo so no line runs through the digits */}
          {labelPoints.map((lp) => (
            <circle key={`d-${lp.id}`} cx={lp.x} cy={lp.dotY} r="3.5" fill={lp.fill} />
          ))}
          {labelPoints.map((lp) => (
            <text
              key={`l-${lp.id}`}
              x={lp.x}
              y={labelY.get(lp.id) ?? lp.dotY - 10}
              textAnchor="middle"
              fontSize="11"
              fontWeight="600"
              fill={lp.labelFill}
              stroke="var(--color-surface,#fff)"
              strokeWidth="3"
              paintOrder="stroke"
            >
              {lp.score}
            </text>
          ))}

          {/* x axis: the set's name (or its date), each section's date under it */}
          {assessments.map((a, i) => (
            <g key={a.key}>
              <text x={xOf(i)} y={H - 22} textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--color-mid-gray,#6B6B6B)">
                {labels[i] ? <title>{a.name ?? labels[i]}</title> : null}
                {labels[i] ? fit(labels[i]!) : fit(formatShortDate(a.date))}
              </text>
              {labels[i] && (
                <text x={xOf(i)} y={H - 9} textAnchor="middle" fontSize="9" fill="var(--color-soft-mute,#9C9999)">
                  {fit(dateLine(i))}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
