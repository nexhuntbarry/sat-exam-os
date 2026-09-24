import PrintableReport from "@/components/analytics/PrintableReport";
import type { AnswerRow, Occasion } from "@/lib/score-analysis";
import { scaleSectionScore } from "@/lib/scoring";
function occ(date: string, label: string, section: string, mult: Record<string, number>): Occasion {
  const r: AnswerRow[] = [];
  const base: Record<string, [string, number][]> = {
    Math: [["Algebra", 0.6], ["Advanced Math", 0.5], ["Geometry and Trigonometry", 0.45], ["Problem Solving and Data Analysis", 0.65]],
    "Reading & Writing": [["Information and Ideas", 0.55], ["Craft and Structure", 0.7], ["Expression of Ideas", 0.4], ["Standard English Conventions", 0.75]],
  };
  for (const [d, p0] of base[section]) { const p = Math.max(0, Math.min(1, p0 * (mult[d] ?? 1))); const t = 8; const c = Math.round(p * t); for (let i = 0; i < t; i++) r.push({ is_correct: i < c, section, domain: d }); }
  const pct = Math.round((r.filter(x=>x.is_correct).length / r.length) * 100);
  return { date, label, rows: r, section, scaledScore: scaleSectionScore(pct) };
}
const occasions: Occasion[] = [
  occ("2026-06-15T10:00:00Z", "August 2024 SAT · Math M1", "Math", {}),
  occ("2026-07-10T10:00:00Z", "October 2024 SAT · Math M1", "Math", { Algebra: 1.2, "Geometry and Trigonometry": 1.2 }),
  occ("2026-08-12T10:00:00Z", "March 2026 SAT · Math M2", "Math", { Algebra: 1.4, "Geometry and Trigonometry": 1.5, "Advanced Math": 1.3 }),
  occ("2026-09-18T10:00:00Z", "September 2025 SAT · Math M2", "Math", { Algebra: 1.5, "Geometry and Trigonometry": 1.8, "Advanced Math": 1.5, "Problem Solving and Data Analysis": 1.3 }),
  occ("2026-07-20T10:00:00Z", "October 2024 SAT · R&W M1", "Reading & Writing", {}),
  occ("2026-09-01T10:00:00Z", "September 2025 SAT · R&W M2", "Reading & Writing", { "Expression of Ideas": 1.4, "Information and Ideas": 1.3 }),
];
const overallRows: AnswerRow[] = occasions.flatMap(o => o.rows);
export default function Preview() {
  return <PrintableReport studentName="Alex Chen" breakdownRows={overallRows} occasions={occasions} generatedOn="September 24, 2026" />;
}
