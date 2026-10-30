"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Columns3 } from "lucide-react";
import { cn } from "./cn";
import { usePopover } from "./usePopover";

/** A column the viewer may show/hide. `locked` columns (name, actions) are
 *  listed but can't be turned off. */
export interface ColumnDef {
  key: string;
  label: string;
  locked?: boolean;
  defaultHidden?: boolean;
}

export interface ColumnPrefs {
  columns: ColumnDef[];
  isVisible: (key: string) => boolean;
  toggle: (key: string) => void;
  reset: () => void;
  /** Number of visible columns, handy for EmptyRow / DataRow colSpan. */
  visibleCount: number;
}

const PREFIX = "sat.table-columns.";

/** Per-viewer column visibility, persisted in localStorage under
 *  `sat.table-columns.<storageKey>`. Storage failures are ignored (falls
 *  back to defaults). Saved prefs load after mount, so the first render
 *  always matches the server. Columns hidden here are not rendered at all;
 *  guard the Th, Td and DetailItem with `prefs.isVisible(key)`. */
export function useColumnPrefs(storageKey: string, columns: ColumnDef[]): ColumnPrefs {
  const defaults = useCallback(
    () => new Set(columns.filter((c) => c.defaultHidden && !c.locked).map((c) => c.key)),
    // columns is expected to be a module-level constant
    [],
  );
  const [hidden, setHidden] = useState<Set<string>>(defaults);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PREFIX + storageKey);
      if (!raw) return;
      const keys: unknown = JSON.parse(raw);
      if (!Array.isArray(keys)) return;
      const allowed = new Set(columns.filter((c) => !c.locked).map((c) => c.key));
      setHidden(new Set(keys.filter((k): k is string => typeof k === "string" && allowed.has(k))));
    } catch {
      /* storage blocked or corrupt: keep defaults */
    }
  }, [storageKey]);

  const persist = useCallback(
    (next: Set<string>) => {
      try {
        window.localStorage.setItem(PREFIX + storageKey, JSON.stringify([...next]));
      } catch {
        /* storage blocked: preference lasts for this page view only */
      }
    },
    [storageKey],
  );

  const toggle = useCallback(
    (key: string) => {
      if (columns.find((c) => c.key === key)?.locked) return;
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        persist(next);
        return next;
      });
    },
    [columns, persist],
  );

  const reset = useCallback(() => {
    const next = defaults();
    setHidden(next);
    persist(next);
  }, [defaults, persist]);

  return {
    columns,
    isVisible: (key) => !hidden.has(key),
    toggle,
    reset,
    visibleCount: columns.filter((c) => !hidden.has(c.key)).length,
  };
}

/** "Columns" button with a checkbox list bound to useColumnPrefs. Place it
 *  in the toolbar above the table. */
export function ColumnsPicker({ prefs, className }: { prefs: ColumnPrefs; className?: string }) {
  const { open, setOpen, anchorRef, popRef, style } = usePopover();
  const panelId = useId();

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-xl border border-divider bg-surface px-3 py-2 text-sm text-mid-gray transition-colors hover:text-charcoal",
          open && "text-charcoal",
          className,
        )}
      >
        <Columns3 size={15} />
        Columns
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={panelId}
            role="dialog"
            aria-label="Choose columns"
            style={style}
            className="z-50 min-w-[12rem] rounded-xl border border-divider bg-surface py-1 shadow-lg"
          >
            {prefs.columns.map((c) => (
              <label
                key={c.key}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 text-sm text-charcoal",
                  c.locked ? "opacity-60" : "cursor-pointer hover:bg-light-bg",
                )}
              >
                <input
                  type="checkbox"
                  className="accent-warm-coral"
                  checked={prefs.isVisible(c.key)}
                  disabled={c.locked}
                  onChange={() => prefs.toggle(c.key)}
                />
                {c.label}
              </label>
            ))}
            <div className="mt-1 border-t border-divider px-3 pt-1.5 pb-1">
              <button type="button" onClick={prefs.reset} className="text-xs text-soft-mute hover:text-charcoal">
                Reset to default
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
