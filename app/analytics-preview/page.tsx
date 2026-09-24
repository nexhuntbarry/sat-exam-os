import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import ProgressReport from "@/components/analytics/ProgressReport";
import PerTestBreakdown from "@/components/analytics/PerTestBreakdown";
import type { AnswerRow, Occasion } from "@/lib/score-analysis";

// TEMPORARY preview (public) — screenshot the analytics layout. Remove after.
function rows(section: string, domain: string, skills: [string, number, number][]): AnswerRow[] {
  const out: AnswerRow[] = [];
  for (const [skill, correct, total] of skills) for (let i = 0; i < total; i++) out.push({ is_correct: i < correct, section, domain, skill });
  return out;
}
const overallRows: AnswerRow[] = [
  ...rows("Math", "Algebra", [["Linear equations", 9, 10], ["Systems", 7, 8]]),
  ...rows("Math", "Advanced Math", [["Quadratics", 6, 9], ["Exponentials", 5, 8]]),
  ...rows("Math", "Geometry and Trigonometry", [["Right triangles", 4, 8], ["Circles", 3, 7]]),
  ...rows("Reading & Writing", "Craft and Structure", [["Words in context", 9, 10]]),
  ...rows("Reading & Writing", "Expression of Ideas", [["Transitions", 4, 9]]),
  ...rows("Reading & Writing", "Standard English Conventions", [["Punctuation", 9, 10]]),
];
function occ(date: string, label: string, mult: Record<string, number>): Occasion {
  const r: AnswerRow[] = [];
  const base: [string, string, number][] = [
    ["Math", "Algebra", 0.6], ["Math", "Advanced Math", 0.5], ["Math", "Geometry and Trigonometry", 0.45],
    ["Reading & Writing", "Craft and Structure", 0.7], ["Reading & Writing", "Expression of Ideas", 0.4], ["Reading & Writing", "Standard English Conventions", 0.75],
  ];
  for (const [s, d, p0] of base) { const p = Math.max(0, Math.min(1, p0 * (mult[d] ?? 1))); const total = 8; const c = Math.round(p * total); for (let i = 0; i < total; i++) r.push({ is_correct: i < c, section: s, domain: d }); }
  return { date, label, rows: r };
}
const occasions: Occasion[] = [
  occ("2026-06-15T10:00:00Z", "August 2024 SAT · Math M1", {}),
  occ("2026-07-10T10:00:00Z", "October 2024 SAT · R&W M1", { Algebra: 1.1, "Geometry and Trigonometry": 1.15 }),
  occ("2026-08-12T10:00:00Z", "March 2026 SAT · Math M2", { Algebra: 1.25, "Geometry and Trigonometry": 1.4, "Expression of Ideas": 1.3 }),
  occ("2026-09-18T10:00:00Z", "September 2025 SAT · R&W M2", { Algebra: 1.35, "Geometry and Trigonometry": 1.7, "Expression of Ideas": 1.6, "Advanced Math": 1.3 }),
];

export default function AnalyticsPreview() {
  return (
    <div className="min-h-screen bg-cream text-charcoal">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div>
          <div className="text-xs uppercase tracking-wide text-warm-coral font-semibold">Preview · sample data</div>
          <h1 className="text-2xl font-bold text-charcoal">Student Analytics</h1>
        </div>
        <ScoreBreakdown rows={overallRows} title="Your Strengths & Focus Areas" />
        <ProgressReport occasions={occasions} title="Your Progress Over Time" />
        <PerTestBreakdown occasions={occasions} title="Score Report — By Test" />
      </div>
    </div>
  );
}
