"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Small "?" that reveals longer help text: on hover / focus on desktop,
// on tap on touch screens. Tap outside closes it.
export default function HelpTip({ children, label = "More info" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex group/help align-middle">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="w-4 h-4 rounded-full border border-divider text-[10px] leading-none font-semibold text-soft-mute hover:text-charcoal hover:border-soft-mute flex items-center justify-center"
      >
        ?
      </button>
      <span
        role="tooltip"
        className={`${open ? "block" : "hidden"} group-hover/help:block group-focus-within/help:block absolute left-0 top-full mt-1.5 z-30 w-64 max-w-[calc(100vw-4rem)] rounded-xl border border-divider bg-surface shadow-lg p-3 text-[11px] font-normal leading-relaxed text-mid-gray text-left whitespace-normal`}
      >
        {children}
      </span>
    </span>
  );
}
