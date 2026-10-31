"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Renders children into document.body. Use for every modal overlay and
 *  popover: a `fixed` element inside a sticky table cell (z-[1]) or an
 *  overflow container is trapped in that stacking context, so later sticky
 *  cells paint over it. In document.body a z-50 overlay is always on top.
 *  Note: React events still bubble to the React parent (e.g. a DataRow);
 *  the kit's DataRow ignores clicks that come from outside its own DOM. */
export function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? createPortal(children, document.body) : null;
}
