"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X, type LucideIcon } from "lucide-react";
import { clsx } from "clsx";

// Topbar's hamburger (md:hidden) dispatches this; the shell listens so
// the server layouts don't need to share client state between the two.
export const SIDEBAR_TOGGLE_EVENT = "sidebar:toggle";

export interface NavItem {
  href: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
}

interface Props {
  heading: string;
  items: NavItem[];
  activeClassName: string;
}

// Desktop: fixed-width left rail (md and up). Mobile: hidden rail, the
// same links open in a slide-over drawer so content gets the full width.
export default function SidebarShell({ heading, items, activeClassName }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onToggle = () => setOpen((o) => !o);
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, onToggle);
  }, []);

  // Close the drawer after navigating.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const nav = (
    <nav className="flex-1 py-4 px-2 overflow-y-auto">
      <p className="px-3 mb-2 text-xs font-semibold text-soft-mute uppercase tracking-widest">
        {heading}
      </p>
      {items.map(({ href, icon: Icon, label, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={clsx(
              "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors mb-0.5",
              active
                ? activeClassName
                : "text-mid-gray hover:text-charcoal hover:bg-light-bg"
            )}
          >
            <Icon size={16} />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      <aside className="hidden md:flex w-56 shrink-0 border-r border-divider flex-col bg-cream min-h-0">
        {nav}
      </aside>

      {open && (
        <div className="md:hidden fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label={`${heading} navigation`}>
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="relative w-64 max-w-[80vw] h-full flex flex-col bg-cream border-r border-divider shadow-xl">
            <div className="flex justify-end px-2 pt-2">
              <button
                onClick={() => setOpen(false)}
                className="p-2.5 rounded-lg text-mid-gray hover:text-charcoal hover:bg-light-bg"
                aria-label="Close menu"
              >
                <X size={18} />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}
    </>
  );
}
