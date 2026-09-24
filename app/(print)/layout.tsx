// Minimal layout for printable pages — no sidebar/topbar, so the report prints
// clean. (The app chrome is also hidden by @media print, but keeping these
// pages chrome-free on screen makes the "what you see is what prints" obvious.)
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-cream text-charcoal">{children}</div>;
}
