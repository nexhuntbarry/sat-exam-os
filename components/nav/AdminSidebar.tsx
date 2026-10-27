"use client";

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
  ShieldCheck,
  Bug,
} from "lucide-react";
import SidebarShell, { type NavItem } from "@/components/nav/SidebarShell";

const navItems: NavItem[] = [
  { href: "/admin", icon: LayoutDashboard, label: "Dashboard", exact: true },
  { href: "/admin/modules", icon: BookOpen, label: "Modules" },
  { href: "/admin/questions", icon: HelpCircle, label: "Question Bank" },
  { href: "/admin/tests", icon: ClipboardList, label: "Tests" },
  { href: "/admin/students", icon: Users, label: "Students" },
  { href: "/admin/teachers", icon: GraduationCap, label: "Teachers" },
  { href: "/admin/admins", icon: ShieldCheck, label: "Admins" },
  { href: "/admin/classes", icon: FolderKanban, label: "Classes" },
  { href: "/admin/reports", icon: BarChart2, label: "Reports" },
  { href: "/admin/bug-reports", icon: Bug, label: "Bug Reports" },
  { href: "/admin/ai-usage", icon: Zap, label: "AI Usage" },
  { href: "/admin/settings", icon: Settings, label: "Settings" },
];

export default function AdminSidebar() {
  return (
    <SidebarShell
      heading="Admin"
      items={navItems}
      activeClassName="bg-warm-coral/15 text-warm-coral-text"
    />
  );
}
