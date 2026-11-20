"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { clsx } from "clsx";

export const STUDENT_TABS = ["overview", "tests", "skills", "profile"] as const;
export type StudentTabId = (typeof STUDENT_TABS)[number];

/**
 * Tabs for the admin / teacher student page. Every panel is rendered once
 * on the server; this only shows one. The tab lives in the URL (?tab=tests,
 * Overview = no param) via history.pushState, so links and Back work without
 * a server round trip. WAI-ARIA tabs pattern: arrow keys / Home / End move
 * between tabs, only the selected tab is in the Tab order.
 */
export default function StudentTabs({
  panels,
}: {
  panels: { id: StudentTabId; label: string; content: ReactNode }[];
}) {
  const params = useSearchParams();
  const asked = params.get("tab");
  const active: StudentTabId = panels.some((p) => p.id === asked) ? (asked as StudentTabId) : "overview";
  const base = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function select(id: StudentTabId) {
    if (id === active) return;
    const next = new URLSearchParams(params.toString());
    if (id === "overview") next.delete("tab");
    else next.set("tab", id);
    const qs = next.toString();
    window.history.pushState(null, "", qs ? `?${qs}` : window.location.pathname);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = panels.length - 1;
    const to =
      e.key === "ArrowRight" ? (i === last ? 0 : i + 1)
      : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (to == null) return;
    e.preventDefault();
    select(panels[to].id);
    tabRefs.current[to]?.focus();
  }

  return (
    <div className="space-y-6">
      <div role="tablist" aria-orientation="horizontal" className="flex gap-1 border-b border-divider overflow-x-auto">
        {panels.map((p, i) => {
          const selected = p.id === active;
          return (
            <button
              key={p.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${p.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${p.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(p.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={clsx(
                "relative -mb-px px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warm-coral/40 rounded-t-lg",
                selected
                  ? "border-warm-coral text-charcoal"
                  : "border-transparent text-mid-gray hover:text-charcoal hover:border-divider",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {panels.map((p) => (
        <div
          key={p.id}
          role="tabpanel"
          id={`${base}-panel-${p.id}`}
          aria-labelledby={`${base}-tab-${p.id}`}
          hidden={p.id !== active}
          tabIndex={0}
          className="space-y-6 focus-visible:outline-none"
        >
          {p.content}
        </div>
      ))}
    </div>
  );
}
