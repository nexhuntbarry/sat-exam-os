"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, ClipboardList, BarChart2, User } from "lucide-react";
import { clsx } from "clsx";

const navItems = [
  { href: "/student", icon: LayoutDashboard, label: "Dashboard", exact: true },
  { href: "/student/tests", icon: ClipboardList, label: "My Tests" },
  { href: "/student/results", icon: BarChart2, label: "Results" },
  { href: "/student/profile", icon: User, label: "Profile" },
];

export default function StudentSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r border-white/5 flex flex-col bg-deep-navy min-h-0">
      <nav className="flex-1 py-4 px-2 overflow-y-auto">
        <p className="px-3 mb-2 text-xs font-semibold text-soft-gray/30 uppercase tracking-widest">
          Student
        </p>
        {navItems.map(({ href, icon: Icon, label, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors mb-0.5",
                active
                  ? "bg-lime-green/15 text-lime-green"
                  : "text-soft-gray/60 hover:text-soft-gray hover:bg-white/5"
              )}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
