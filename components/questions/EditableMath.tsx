"use client";

import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import MathMarkdown from "@/components/MathMarkdown";

/**
 * Edit-in-place field for the review page: shows the rendered text; click it
 * to edit the source right there, with a live preview under the same box.
 * Click outside, Esc or "Done" closes the editor (edits are kept in the page
 * state; saving is the page's job).
 */
export default function EditableMath({
  value,
  onChange,
  label,
  rows = 4,
  className,
  emptyText = "Click to add text",
}: {
  value: string;
  onChange: (next: string) => void;
  /** Accessible name, e.g. "Question text" or "Choice A". */
  label: string;
  rows?: number;
  className?: string;
  emptyText?: string;
}) {
  const [editing, setEditing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const el = areaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setEditing(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editing]);

  // Math or Markdown worth previewing while typing.
  const rich = /[$\\*_|#]/.test(value);

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`Edit ${label}`}
        title="Click to edit"
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setEditing(true);
          }
        }}
        className={clsx(
          "cursor-text rounded-xl border border-divider bg-light-bg px-3 py-2 transition-colors hover:border-warm-coral/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warm-coral/40",
          className,
        )}
      >
        {value.trim() ? (
          <MathMarkdown className="prose prose-sm max-w-none text-charcoal [&_p]:my-0.5">{value}</MathMarkdown>
        ) : (
          <span className="text-sm italic text-soft-mute">{emptyText}</span>
        )}
      </div>
    );
  }

  return (
    <div ref={boxRef} className={clsx("rounded-xl border border-warm-coral/50 bg-surface p-2 shadow-sm", className)}>
      <textarea
        ref={areaRef}
        aria-label={label}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        className="w-full resize-y rounded-lg bg-light-bg px-2.5 py-2 font-mono text-[13px] leading-relaxed text-charcoal focus:outline-none"
      />
      {rich && (
        <div className="mt-1.5 rounded-lg border border-dashed border-divider px-2.5 py-1.5">
          <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-soft-mute">Preview</p>
          <MathMarkdown className="prose prose-sm max-w-none text-charcoal [&_p]:my-0.5">{value}</MathMarkdown>
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-soft-mute">
        <span>Esc or click outside to close · Ctrl/⌘+S to save</span>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="rounded-md px-2 py-0.5 font-medium text-charcoal hover:bg-light-bg"
        >
          Done
        </button>
      </div>
    </div>
  );
}
