"use client";

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
import SidebarShell, { type NavItem } from "@/components/nav/SidebarShell";

const baseNavItems: NavItem[] = [
  { href: "/teacher", icon: LayoutDashboard, label: "Dashboard", exact: true },
  { href: "/teacher/teaching-mode", icon: Presentation, label: "Teaching Mode" },
  { href: "/teacher/classes", icon: Users, label: "My Classes" },
  { href: "/teacher/tests", icon: ClipboardList, label: "My Tests" },
  { href: "/teacher/results", icon: BarChart2, label: "Student Results" },
  { href: "/teacher/analysis", icon: BookOpen, label: "Question Analysis" },
  { href: "/teacher/help", icon: HelpCircle, label: "Quick Start" },
  { href: "/teacher/settings", icon: Settings, label: "Settings" },
];

const reviewerItem: NavItem = {
  href: "/reviewer/questions",
  icon: ShieldCheck,
  label: "Question Review",
  exact: false,
};

interface Props {
  canReview?: boolean;
}

export default function TeacherSidebar({ canReview = false }: Props) {
  const navItems = canReview
    ? [...baseNavItems.slice(0, 6), reviewerItem, ...baseNavItems.slice(6)]
    : baseNavItems;

  return (
    <SidebarShell
      heading="Teacher"
      items={navItems}
      activeClassName="bg-warm-coral/15 text-warm-coral"
    />
  );
}
