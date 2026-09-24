import ScoreProgressChart from "@/components/analytics/ScoreProgressChart";
import ScoreBreakdown from "@/components/analytics/ScoreBreakdown";
import ProgressReport from "@/components/analytics/ProgressReport";
import PerTestBreakdown from "@/components/analytics/PerTestBreakdown";
import PrintButton from "@/components/analytics/PrintButton";
import type { AnswerRow, Occasion } from "@/lib/score-analysis";

// A full, print-optimized score report for one student: score progression,
// overall strengths/weaknesses, progress trend, and every test's own report.
// The page's @media print CSS (globals.css) strips the app chrome and expands
// collapsed sections so the whole thing prints to a clean PDF.
export default function PrintableReport({
  studentName,
  breakdownRows,
  occasions,
  generatedOn,
}: {
  studentName: string;
  breakdownRows: AnswerRow[];
  occasions: Occasion[];
  generatedOn: string;
}) {
  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6 print:p-0 print:max-w-none">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-divider pb-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-warm-coral font-semibold">SAT Score Report</div>
          <h1 className="text-2xl font-bold text-charcoal">{studentName}</h1>
          <p className="text-soft-mute text-sm">Generated {generatedOn}</p>
        </div>
        <PrintButton />
      </div>

      {occasions.length > 0 && <ScoreProgressChart occasions={occasions} />}
      {breakdownRows.length > 0 && <ScoreBreakdown rows={breakdownRows} title="Overall Strengths & Focus Areas" />}
      {occasions.length > 0 && <ProgressReport occasions={occasions} title="Progress Over Time" />}
      {occasions.length > 0 && <PerTestBreakdown occasions={occasions} title="Score Report — By Test" />}

      <p className="no-print text-center text-xs text-soft-mute pt-2">Tip: in the print dialog, choose “Save as PDF” as the destination.</p>
    </div>
  );
}
