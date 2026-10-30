"use client";

import { useEffect, useId, type ComponentType, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import { cn } from "./cn";
import { usePopover } from "./usePopover";

/** One entry of a RowActionsMenu. Give either `href` (navigates) or
 *  `onSelect` (runs after the menu closes, so prompt()/confirm() and modals
 *  open over a closed menu). */
export interface RowAction {
  label: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
  href?: string;
  onSelect?: () => void;
  /** "danger" renders the item in the error colour (suspend, delete, reject). */
  tone?: "default" | "danger";
  disabled?: boolean;
}

/** The "⋯" row-actions button + menu. `items` may contain false/null for
 *  conditional actions. Accessible: aria-haspopup/aria-expanded, arrow keys,
 *  Home/End, Escape (returns focus), Tab and outside-click close; rendered in
 *  a portal with fixed positioning so overflow containers never clip it. */
export function RowActionsMenu({
  items,
  label = "Row actions",
}: {
  items: (RowAction | false | null | undefined)[];
  /** Accessible name, e.g. `Actions for ${name}`. */
  label?: string;
}) {
  const { open, setOpen, close, anchorRef, popRef, style } = usePopover();
  const menuId = useId();
  const actions = items.filter((i): i is RowAction => Boolean(i));

  function menuItems(): HTMLElement[] {
    return Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
  }

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (open) menuItems()[0]?.focus();
  }, [open]);

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const list = menuItems();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === "Tab") {
      close();
    }
  }

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  }

  if (actions.length === 0) return null;

  const itemCls = (a: RowAction) =>
    cn(
      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm whitespace-nowrap outline-none",
      "focus:bg-light-bg hover:bg-light-bg",
      a.tone === "danger" ? "text-status-error" : "text-charcoal",
      a.disabled && "opacity-50 pointer-events-none",
    );

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-lg text-soft-mute align-middle transition-colors",
          "hover:bg-light-bg hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warm-coral/40",
          open && "bg-light-bg text-charcoal",
        )}
      >
        <MoreHorizontal size={18} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={menuId}
            role="menu"
            aria-label={label}
            style={style}
            onKeyDown={onMenuKey}
            className="z-50 min-w-[11rem] overflow-hidden rounded-xl border border-divider bg-surface py-1 shadow-lg"
          >
            {actions.map((a) => {
              const Icon = a.icon;
              const content = (
                <>
                  {Icon && <Icon size={14} className="shrink-0" />}
                  {a.label}
                </>
              );
              if (a.href && !a.disabled) {
                return (
                  <Link key={a.label} href={a.href} role="menuitem" tabIndex={-1} className={itemCls(a)} onClick={() => close()}>
                    {content}
                  </Link>
                );
              }
              return (
                <button
                  key={a.label}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={a.disabled || undefined}
                  className={itemCls(a)}
                  onClick={() => {
                    if (a.disabled) return;
                    close(true);
                    if (a.onSelect) setTimeout(a.onSelect, 0);
                  }}
                >
                  {content}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
