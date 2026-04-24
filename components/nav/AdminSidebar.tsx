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
  { href: "/admin/settings", icon: Settings, label: "Settings" },
];

export default function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r border-white/5 flex flex-col bg-deep-navy min-h-0">
      <nav className="flex-1 py-4 px-2 overflow-y-auto">
        <p className="px-3 mb-2 text-xs font-semibold text-soft-gray/30 uppercase tracking-widest">
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
                  ? "bg-electric-blue/15 text-electric-blue"
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
