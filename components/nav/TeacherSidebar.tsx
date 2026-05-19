"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ClipboardList,
  BarChart2,
  BookOpen,
  Settings,
  Presentation,
  HelpCircle,
  ShieldCheck,
  Users,
} from "lucide-react";
import { clsx } from "clsx";

const baseNavItems = [
  { href: "/teacher", icon: LayoutDashboard, label: "Dashboard", exact: true },
  { href: "/teacher/teaching-mode", icon: Presentation, label: "Teaching Mode" },
  { href: "/teacher/classes", icon: Users, label: "My Classes" },
  { href: "/teacher/tests", icon: ClipboardList, label: "My Tests" },
  { href: "/teacher/results", icon: BarChart2, label: "Student Results" },
  { href: "/teacher/analysis", icon: BookOpen, label: "Question Analysis" },
  { href: "/teacher/help", icon: HelpCircle, label: "Quick Start" },
  { href: "/teacher/settings", icon: Settings, label: "Settings" },
];

const reviewerItem = {
  href: "/reviewer/questions",
  icon: ShieldCheck,
  label: "Question Review",
  exact: false,
};

interface Props {
  canReview?: boolean;
}

export default function TeacherSidebar({ canReview = false }: Props) {
  const pathname = usePathname();
  const navItems = canReview
    ? [...baseNavItems.slice(0, 6), reviewerItem, ...baseNavItems.slice(6)]
    : baseNavItems;

  return (
    <aside className="w-56 shrink-0 border-r border-divider flex flex-col bg-cream min-h-0">
      <nav className="flex-1 py-4 px-2 overflow-y-auto">
        <p className="px-3 mb-2 text-xs font-semibold text-soft-mute uppercase tracking-widest">
          Teacher
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
                  ? "bg-warm-coral/15 text-warm-coral"
                  : "text-mid-gray hover:text-charcoal hover:bg-light-bg"
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
