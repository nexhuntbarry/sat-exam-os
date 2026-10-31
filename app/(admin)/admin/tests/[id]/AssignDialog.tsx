"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, UserPlus } from "lucide-react";
import { clsx } from "clsx";
import AddStudentsButton from "./AddStudentsButton";
import AssignClassGroupsButton from "./AssignClassGroupsButton";
import AssignTeachersButton from "./AssignTeachersButton";
import { Portal } from "@/components/ui/Portal";

type Tab = "students" | "classes" | "teachers";

interface Props {
  testId: string;
  studentIds: string[];
  classGroupIds: string[];
  teacherIds: string[];
  allClassGroups: { id: string; name: string; campus: string | null; grade: string | null }[];
  allTeachers: { id: string; display_name: string | null; email: string }[];
  /** "button": one Assign button (detail page). "menu": "Assign ▾" picking the tab (tests list). */
  variant?: "button" | "menu";
}

// One entry point for the three existing assignment dialogs. Each tab is
// the existing dialog (same API calls), shown with a tab bar on top.
export default function AssignDialog({
  testId,
  studentIds,
  classGroupIds,
  teacherIds,
  allClassGroups,
  allTeachers,
  variant = "button",
}: Props) {
  const [tab, setTab] = useState<Tab | null>(null);
  const [menuAt, setMenuAt] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The list's table scrolls sideways, which would clip an absolute menu,
  // so the menu is fixed to the viewport and closes on scroll / resize.
  useEffect(() => {
    if (!menuAt) return;
    const close = () => setMenuAt(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuAt]);

  const labels: { key: Tab; label: string; count: number }[] = [
    { key: "students", label: "Students", count: studentIds.length },
    { key: "classes", label: "Classes", count: classGroupIds.length },
    { key: "teachers", label: "Teachers", count: teacherIds.length },
  ];

  const tabs = (
    <div className="flex gap-1 px-3 pt-3 border-b border-divider" role="tablist">
      {labels.map((l) => (
        <button
          key={l.key}
          role="tab"
          aria-selected={tab === l.key}
          onClick={() => setTab(l.key)}
          className={clsx(
            "px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors",
            tab === l.key
              ? "border-warm-coral text-charcoal"
              : "border-transparent text-soft-mute hover:text-charcoal",
          )}
        >
          {l.label}
          <span className="ml-1 text-xs text-soft-mute">{l.count}</span>
        </button>
      ))}
    </div>
  );

  const close = () => setTab(null);

  return (
    <>
      {variant === "button" ? (
        <button
          onClick={() => setTab("students")}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold text-sm transition-colors"
        >
          <UserPlus size={14} />
          Assign
        </button>
      ) : (
        <button
          ref={triggerRef}
          onClick={() => {
            if (menuAt) return setMenuAt(null);
            const r = triggerRef.current!.getBoundingClientRect();
            setMenuAt({ top: r.bottom + 4, right: window.innerWidth - r.right });
          }}
          aria-haspopup="menu"
          aria-expanded={Boolean(menuAt)}
          className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-lg bg-warm-coral px-2.5 text-xs font-medium text-white align-middle transition-colors hover:bg-warm-coral-dark"
        >
          Assign
          <ChevronDown size={12} />
        </button>
      )}

      {/* Portal: inside the sticky actions cell the menu would share its
          stacking context and later rows' sticky cells would paint over it. */}
      {menuAt && (
        <Portal>
        <div
          ref={menuRef}
          role="menu"
          style={{ top: menuAt.top, right: menuAt.right }}
          className="fixed z-50 min-w-[9rem] bg-surface border border-divider rounded-xl shadow-lg py-1"
        >
          {labels.map((l) => (
            <button
              key={l.key}
              role="menuitem"
              onClick={() => {
                setMenuAt(null);
                setTab(l.key);
              }}
              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-charcoal hover:bg-light-bg text-left"
            >
              {l.label}
              <span className="text-xs text-soft-mute">{l.count}</span>
            </button>
          ))}
        </div>
        </Portal>
      )}

      {tab === "students" && (
        <AddStudentsButton testId={testId} alreadyAssigned={studentIds} open onClose={close} tabs={tabs} />
      )}
      {tab === "classes" && (
        <AssignClassGroupsButton
          testId={testId}
          allClassGroups={allClassGroups}
          currentClassGroupIds={classGroupIds}
          open
          onClose={close}
          tabs={tabs}
        />
      )}
      {tab === "teachers" && (
        <AssignTeachersButton
          testId={testId}
          allTeachers={allTeachers}
          currentTeacherIds={teacherIds}
          open
          onClose={close}
          tabs={tabs}
        />
      )}
    </>
  );
}
