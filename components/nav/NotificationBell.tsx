"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";

interface Notification {
  id: string;
  type: string;
  payload: {
    kind?: string;
    question_id?: string;
    module_id?: string | null;
    question_number?: number | null;
    module_name?: string | null;
    message?: string;
    auto?: boolean;
  } | null;
  read_at: string | null;
  created_at: string;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: Notification[]; unread: number };
      setItems(data.items ?? []);
      setUnread(data.unread ?? 0);
    } catch {
      /* offline / transient — keep last state */
    }
  }, []);

  // Poll every 60s + on mount.
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markAllRead = useCallback(async () => {
    if (unread === 0) return;
    setUnread(0);
    setItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() })));
    try {
      await fetch("/api/notifications/read", { method: "POST" });
    } catch {
      /* optimistic — reload will reconcile */
    }
  }, [unread]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void markAllRead();
  };

  function href(n: Notification): string {
    const q = n.payload?.question_id;
    return q ? `/admin/questions/${q}` : "#";
  }

  function line(n: Notification): { title: string; body: string } {
    const p = n.payload ?? {};
    if (p.kind === "bug_report_resolved") {
      const where = p.module_name
        ? `${p.module_name}${p.question_number != null ? ` · Q${p.question_number}` : ""}`
        : p.question_number != null
          ? `Q${p.question_number}`
          : "your reported question";
      return {
        title: `Report resolved — ${where}`,
        body: p.message || "The issue you reported was fixed.",
      };
    }
    return { title: n.type, body: p.message || "" };
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        className="relative p-2 rounded-lg text-mid-gray hover:text-charcoal hover:bg-light-bg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warm-coral"
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
        aria-expanded={open}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-warm-coral text-white text-[10px] font-semibold leading-4 text-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-divider bg-surface shadow-lg z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-divider flex items-center justify-between">
            <span className="text-sm font-semibold text-charcoal">Notifications</span>
            {unread > 0 && <span className="text-xs text-soft-mute">{unread} new</span>}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-soft-mute">No notifications yet.</div>
            ) : (
              items.map((n) => {
                const { title, body } = line(n);
                return (
                  <Link
                    key={n.id}
                    href={href(n)}
                    onClick={() => setOpen(false)}
                    className={`block px-4 py-3 border-b border-divider/60 last:border-b-0 hover:bg-light-bg transition-colors ${n.read_at ? "" : "bg-warm-coral/5"}`}
                  >
                    <div className="flex items-start gap-2">
                      {!n.read_at && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-warm-coral shrink-0" />}
                      <div className={n.read_at ? "pl-3.5" : ""}>
                        <div className="text-sm font-medium text-charcoal leading-snug">{title}</div>
                        <div className="text-xs text-mid-gray mt-0.5 leading-snug line-clamp-3">{body}</div>
                        <div className="text-[11px] text-soft-mute mt-1">{timeAgo(n.created_at)}</div>
                      </div>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
