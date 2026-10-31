"use client";

import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import { cn } from "./cn";

const TONE = {
  primary: "bg-warm-coral text-white hover:bg-warm-coral-dark",
  default: "border border-divider bg-surface text-charcoal hover:bg-light-bg",
  danger: "border border-status-error/30 bg-surface text-status-error hover:bg-status-error/10",
} as const;

/** Visible one-click row action (rule 4): the most common action for the
 *  row's current state. Goes in the sticky-right actions cell before the
 *  ⋯ menu. Give `href` (navigates; usable from Server Components) or
 *  `onClick` (client callers only). `icon` must be a rendered element such
 *  as `<Check size={13} />`, never a component. */
export function RowButton({
  label,
  href,
  onClick,
  icon,
  tone = "default",
  disabled,
  title,
}: {
  label: string;
  href?: string;
  onClick?: () => void;
  icon?: ReactElement;
  tone?: keyof typeof TONE;
  disabled?: boolean;
  title?: string;
}) {
  const cls = cn(
    "inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs font-medium align-middle transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warm-coral/40",
    TONE[tone],
    disabled && "opacity-50 pointer-events-none",
  );
  const content = (
    <>
      {icon && <span className="inline-flex shrink-0">{icon}</span>}
      {label}
    </>
  );
  if (href && !disabled) {
    return (
      <Link href={href} className={cls} title={title}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls} title={title}>
      {content}
    </button>
  );
}

/** Wraps the visible buttons + ⋯ of an actions cell on one line. */
export function RowActions({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap align-middle">{children}</span>;
}
