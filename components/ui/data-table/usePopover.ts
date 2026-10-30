"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Internal: positions a portal'd popover (position: fixed) under its anchor,
 *  right-aligned, flipping above when there is no room below. Closes on
 *  Escape, outside mousedown, scroll of any ancestor, and resize. Fixed
 *  positioning + a portal means overflow-x-auto table wrappers can't clip it. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: 0, left: 0, visibility: "hidden" });

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) anchorRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const a = anchorRef.current?.getBoundingClientRect();
    const p = popRef.current;
    if (!a || !p) return;
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    const gap = 4;
    const margin = 8;
    const left = Math.min(Math.max(margin, a.right - w), window.innerWidth - w - margin);
    const below = a.bottom + gap;
    const top = below + h > window.innerHeight - margin && a.top - gap - h >= margin ? a.top - gap - h : below;
    setStyle({ position: "fixed", top, left, visibility: "visible" });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    }
    function onScroll(e: Event) {
      if (popRef.current?.contains(e.target as Node)) return;
      close();
    }
    function onResize() {
      close();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  return { open, setOpen, close, anchorRef, popRef, style };
}
