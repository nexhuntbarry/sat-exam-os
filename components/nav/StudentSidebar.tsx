"use client";

import { LayoutDashboard, ClipboardList, BarChart2, User } from "lucide-react";
import SidebarShell, { type NavItem } from "@/components/nav/SidebarShell";

const navItems: NavItem[] = [
  { href: "/student", icon: LayoutDashboard, label: "Dashboard", exact: true },
  { href: "/student/tests", icon: ClipboardList, label: "My Tests" },
  { href: "/student/results", icon: BarChart2, label: "Results" },
  { href: "/student/profile", icon: User, label: "Profile" },
];

export default function StudentSidebar() {
  return (
    <SidebarShell
      heading="Student"
      items={navItems}
      activeClassName="bg-warm-amber/15 text-warm-amber"
    />
  );
}
