"use client";

import { UserButton } from "@clerk/nextjs";
import Logo from "@/components/Logo";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import NotificationBell from "@/components/nav/NotificationBell";
import { SIDEBAR_TOGGLE_EVENT } from "@/components/nav/SidebarShell";
import { Menu } from "lucide-react";

interface TopbarProps {
  title?: string;
}

export default function Topbar({ title }: TopbarProps) {
  return (
    <header className="h-16 border-b border-divider flex items-center px-4 md:px-6 gap-3 md:gap-4 bg-surface/90 backdrop-blur-md sticky top-0 z-40">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(SIDEBAR_TOGGLE_EVENT))}
          className="md:hidden -ml-2 p-2.5 rounded-lg text-mid-gray hover:text-charcoal hover:bg-light-bg"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        <Logo size={28} />
        {title && (
          <span className="text-soft-mute text-sm font-medium hidden md:block">
            {title}
          </span>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2 md:gap-3">
        <LanguageSwitcher />

        <NotificationBell />

        <UserButton
          appearance={{
            elements: {
              avatarBox: "w-8 h-8 ring-1 ring-divider",
            },
          }}
        />
      </div>
    </header>
  );
}
