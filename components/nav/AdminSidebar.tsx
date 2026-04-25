"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BookOpen,
  HelpCircle,
  ClipboardList,
  Users,
  GraduationCap,
  FolderKanban,
  BarChart2,
  Settings,
  Zap,
} from "lucide-react";
import { clsx } from "clsx";

const navItems = [
  { href: "/admin", icon: LayoutDashboard, label: "Dashboard", exact: true },
  { href: "/admin/modules", icon: BookOpen, label: "Modules" },
  { href: "/admin/questions", icon: HelpCircle, label: "Question Bank" },
  { href: "/admin/tests", icon: ClipboardList, label: "Tests" },
  { href: "/admin/students", icon: Users, label: "Students" },
  { href: "/admin/teachers", icon: GraduationCap, label: "Teachers" },
  { href: "/admin/classes", icon: FolderKanban, label: "Classes" },
  { href: "/admin/reports", icon: BarChart2, label: "Reports" },
  { href: "/admin/ai-usage", icon: Zap, label: "AI Usage" },
  { href: "/admin/settings", icon: Settings, label: "Settings" },
];

export default function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r border-divider flex flex-col bg-cream min-h-0">
      <nav className="flex-1 py-4 px-2 overflow-y-auto">
        <p className="px-3 mb-2 text-xs font-semibold text-soft-mute uppercase tracking-widest">
          Admin
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
