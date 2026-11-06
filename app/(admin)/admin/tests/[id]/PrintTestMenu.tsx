"use client";

import { useEffect, useRef, useState } from "react";
import { Printer, FileText, KeyRound } from "lucide-react";

// Print a paper copy of the test: blank, or with the answer key. Each opens
// the printable page in a new tab (see app/(print)/print/tests/[id]).
export default function PrintTestMenu({ testId }: { testId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const itemClass =
    "w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-charcoal hover:bg-light-bg transition-colors";

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-light-bg hover:bg-divider text-charcoal font-semibold text-sm transition-colors"
      >
        <Printer size={16} />
        Print
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-40 w-60 bg-surface border border-divider rounded-xl shadow-lg py-1"
        >
          <a
            href={`/print/tests/${testId}`}
            target="_blank"
            rel="noopener"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={itemClass}
          >
            <FileText size={14} />
            Blank test
          </a>
          <a
            href={`/print/tests/${testId}?key=1`}
            target="_blank"
            rel="noopener"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={itemClass}
          >
            <KeyRound size={14} />
            Test with answer key
          </a>
        </div>
      )}
    </div>
  );
}
