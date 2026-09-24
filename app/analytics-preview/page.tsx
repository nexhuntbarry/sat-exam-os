import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import ProgressReport from "@/components/analytics/ProgressReport";
import type { AnswerRow, Occasion } from "@/lib/score-analysis";

// TEMPORARY preview page (public) — renders the analytics components with
// realistic sample data so we can screenshot the layout. Remove after.

// Build answer rows for a domain at a target accuracy.
function rows(section: string, domain: string, skills: [string, number, number][]): AnswerRow[] {
  const out: AnswerRow[] = [];
  for (const [skill, correct, total] of skills) {
    for (let i = 0; i < total; i++) out.push({ is_correct: i < correct, section, domain, skill });
  }
  return out;
}

const overallRows: AnswerRow[] = [
  ...rows("Math", "Algebra", [["Linear equations", 9, 10], ["Systems of equations", 7, 8], ["Inequalities", 6, 8]]),
  ...rows("Math", "Advanced Math", [["Quadratics", 6, 9], ["Exponential functions", 5, 8], ["Polynomials", 4, 7]]),
  ...rows("Math", "Problem Solving and Data Analysis", [["Ratios & percentages", 8, 9], ["Reading data", 5, 8]]),
  ...rows("Math", "Geometry and Trigonometry", [["Right triangles", 4, 8], ["Circles", 3, 7]]),
  ...rows("Reading & Writing", "Information and Ideas", [["Command of evidence", 7, 10], ["Inferences", 5, 8]]),
  ...rows("Reading & Writing", "Craft and Structure", [["Words in context", 9, 10], ["Text structure", 6, 8]]),
  ...rows("Reading & Writing", "Expression of Ideas", [["Transitions", 4, 9], ["Rhetorical synthesis", 4, 8]]),
  ...rows("Reading & Writing", "Standard English Conventions", [["Punctuation", 9, 10], ["Subject-verb agreement", 8, 9]]),
];

// Four test occasions over three months, with visible improvement in a few areas.
function occasion(date: string, mult: Record<string, number>): Occasion {
  const r: AnswerRow[] = [];
  const base: [string, string, number][] = [
    ["Math", "Algebra", 0.6],
    ["Math", "Advanced Math", 0.5],
    ["Math", "Problem Solving and Data Analysis", 0.65],
    ["Math", "Geometry and Trigonometry", 0.45],
    ["Reading & Writing", "Information and Ideas", 0.55],
    ["Reading & Writing", "Craft and Structure", 0.7],
    ["Reading & Writing", "Expression of Ideas", 0.4],
    ["Reading & Writing", "Standard English Conventions", 0.75],
  ];
  for (const [section, domain, p0] of base) {
    const p = Math.max(0, Math.min(1, p0 * (mult[domain] ?? 1)));
    const total = 8;
    const correct = Math.round(p * total);
    for (let i = 0; i < total; i++) r.push({ is_correct: i < correct, section, domain });
  }
  return { date, rows: r };
}

const occasions: Occasion[] = [
  occasion("2026-06-15T10:00:00Z", {}),
  occasion("2026-07-10T10:00:00Z", { Algebra: 1.1, "Geometry and Trigonometry": 1.15, "Expression of Ideas": 1.1 }),
  occasion("2026-08-12T10:00:00Z", { Algebra: 1.25, "Geometry and Trigonometry": 1.4, "Expression of Ideas": 1.3, "Advanced Math": 1.15 }),
  occasion("2026-09-18T10:00:00Z", { Algebra: 1.35, "Geometry and Trigonometry": 1.7, "Expression of Ideas": 1.6, "Advanced Math": 1.3, "Information and Ideas": 0.85 }),
];

export default function AnalyticsPreview() {
  return (
    <div className="min-h-screen bg-cream text-charcoal">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div>
          <div className="text-xs uppercase tracking-wide text-warm-coral font-semibold">Preview · sample data</div>
          <h1 className="text-2xl font-bold text-charcoal">Student Analytics</h1>
          <p className="text-soft-mute text-sm">How the Score Breakdown, skill drill-down, and Progress report look.</p>
        </div>
        <ScoreBreakdown rows={overallRows} title="Your Strengths & Focus Areas" />
        <ProgressReport occasions={occasions} title="Your Progress Over Time" />
      </div>
    </div>
  );
}
