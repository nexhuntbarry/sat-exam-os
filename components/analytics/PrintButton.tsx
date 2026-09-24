"use client";

import { Download } from "lucide-react";

// Opens the browser print dialog → "Save as PDF". The page's @media print CSS
// strips the app chrome and lays the report out for paper.
export default function PrintButton({ label = "Download PDF" }: { label?: string }) {
  return (
    <button
      onClick={() => window.print()}
      className="no-print inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral text-white text-sm font-semibold hover:bg-warm-coral-dark transition-colors"
    >
      <Download size={16} />
      {label}
    </button>
  );
}
