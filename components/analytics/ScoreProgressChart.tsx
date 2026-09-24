import type { Occasion } from "@/lib/score-analysis";
import { TrendingUp } from "lucide-react";

// SAT scaled-score progression (200–800) over a student's tests, one line per
// section. Inline SVG, no client JS, no deps. Shows the number climbing (e.g.
// 500 → 700) which is the parent-facing headline.
const SECTION_COLOR: Record<string, string> = {
  Math: "var(--color-status-info, #0284C7)",
  "Reading & Writing": "var(--color-warm-coral, #F0523D)",
};

export default function ScoreProgressChart({
  occasions,
  height = 240,
}: {
  occasions: Occasion[];
  height?: number;
}) {
  const scored = occasions
    .filter((o) => o.scaledScore != null && o.section)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (scored.length < 2) return null;

  const bySection = new Map<string, { date: string; score: number }[]>();
  for (const o of scored) {
    const arr = bySection.get(o.section!) ?? [];
    arr.push({ date: o.date, score: o.scaledScore! });
    bySection.set(o.section!, arr);
  }
  const sections = [...bySection.keys()];

  // Layout
  const W = 680, H = height, padL = 42, padR = 16, padT = 18, padB = 28;
  const allDates = [...new Set(scored.map((o) => o.date))].sort();
  const n = allDates.length;
  const xOf = (date: string) => {
    const i = allDates.indexOf(date);
    return n === 1 ? (W - padL - padR) / 2 + padL : padL + (i * (W - padL - padR)) / (n - 1);
  };
  const yMin = 200, yMax = 800;
  const yOf = (s: number) => padT + (1 - (Math.max(yMin, Math.min(yMax, s)) - yMin) / (yMax - yMin)) * (H - padT - padB);
  const gridY = [200, 350, 500, 650, 800];

  return (
    <div className="rounded-2xl border border-divider bg-surface p-5 md:p-6">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <TrendingUp size={18} className="text-warm-coral" />
          <h2 className="text-base font-semibold text-charcoal">SAT Score Progression</h2>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {sections.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5 text-mid-gray">
              <span className="w-3 h-0.5 rounded" style={{ background: SECTION_COLOR[s] ?? "#888" }} />
              {s}
            </span>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="max-w-full">
          {/* gridlines + y labels */}
          {gridY.map((g) => (
            <g key={g}>
              <line x1={padL} y1={yOf(g)} x2={W - padR} y2={yOf(g)} stroke="var(--color-divider,#E4E4E4)" strokeWidth="1" strokeDasharray={g === 200 ? "0" : "2 3"} />
              <text x={padL - 8} y={yOf(g) + 3} textAnchor="end" fontSize="10" fill="var(--color-soft-mute,#9C9999)">{g}</text>
            </g>
          ))}
          {/* one polyline per section */}
          {sections.map((s) => {
            const pts = bySection.get(s)!;
            const color = SECTION_COLOR[s] ?? "#888";
            const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.date).toFixed(1)},${yOf(p.score).toFixed(1)}`).join(" ");
            return (
              <g key={s}>
                <path d={d} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                {pts.map((p, i) => (
                  <g key={i}>
                    <circle cx={xOf(p.date)} cy={yOf(p.score)} r="3.5" fill={color} />
                    <text x={xOf(p.date)} y={yOf(p.score) - 8} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--color-charcoal,#1F1F1F)">{p.score}</text>
                  </g>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
