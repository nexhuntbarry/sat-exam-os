"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { waitForImages } from "@/lib/print-images";

// Opens the browser print dialog → "Save as PDF". The page's @media print CSS
// strips the app chrome and lays the report out for paper. Waits for every
// figure first (a print snapshot draws nothing for an image still loading)
// and names any image that failed so nobody prints a test missing a diagram.
export default function PrintButton({ label = "Download PDF" }: { label?: string }) {
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [failed, setFailed] = useState<string[]>([]);

  async function onClick() {
    setFailed([]);
    const res = await waitForImages(document, { onProgress: (loaded, total) => setProgress({ loaded, total }) });
    setProgress(null);
    setFailed(res.failed);
    window.print();
  }

  return (
    <div className="no-print flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        disabled={progress !== null}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral text-white text-sm font-semibold hover:bg-warm-coral-dark transition-colors disabled:opacity-70 disabled:cursor-wait"
      >
        {progress ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
        {progress ? `Loading images… ${progress.loaded}/${progress.total}` : label}
      </button>
      {failed.length > 0 && (
        <p role="alert" className="text-xs text-status-error max-w-sm text-right">
          {failed.length} image{failed.length === 1 ? "" : "s"} didn&apos;t load and will be missing on paper: {failed.join(", ")}.
          Reload the page and try again.
        </p>
      )}
    </div>
  );
}

// Ctrl/Cmd+P skips the Print button: while any figure on the page is still
// loading, this print-only notice says so at the top of the paper instead of
// the diagrams silently going missing. Place it outside any .no-print block.
export function PrintPendingNotice() {
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const update = () => setPending(Array.from(document.images).some((i) => !i.complete));
    // load/error don't bubble: capture them, images only.
    const check = (e?: Event) => {
      if (!e || e.target instanceof HTMLImageElement) update();
    };
    check();
    document.addEventListener("load", check, true);
    document.addEventListener("error", check, true);
    return () => {
      document.removeEventListener("load", check, true);
      document.removeEventListener("error", check, true);
    };
  }, []);
  if (!pending) return null;
  return (
    <p className="hidden print:block mb-3 p-2 border-2 border-charcoal text-sm font-semibold">
      Some figures were still loading when this was printed and may be missing. Wait for the page to finish loading
      and use the Print button.
    </p>
  );
}
