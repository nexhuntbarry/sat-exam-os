"use client";

// Live progress cells for pages that watch a test being taken (admin
// Submissions, teacher test page, class Scores grid). Wrap the table in
// <LiveProgressProvider> with the server-rendered snapshot
// (lib/live-progress loadLiveSnapshot) and its polling endpoint; drop
// <LiveProgressCell attemptKey> / <LiveTabSwitchCount> into rows and
// <LiveStatusBar> above the table. Rows only change in place; when a
// student starts or finishes, the page's server rows are re-rendered with
// router.refresh() (no full reload, scroll position kept).

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TabSwitchCount } from "@/components/analytics/TabSwitchCount";
import { cn } from "@/components/ui/data-table/cn";
import { formatTime } from "@/lib/datetime";
import {
  LIVE_POLL_MS,
  WAITING_POLL_MS,
  answeredPercent,
  connectionStatus,
  positionText,
  secondsLeftAfter,
  snapshotShapeChanged,
  summaryText,
  timeLeftText,
  updatedAgoText,
  type ConnectionKind,
  type LiveSnapshot,
} from "@/lib/live-progress-shared";

interface LiveState {
  snapshot: LiveSnapshot;
  /** Client clock when the snapshot arrived (countdowns run from here). */
  receivedAt: number;
  /** Client clock now (ticks every second while anyone is live). */
  now: number;
  /** Polling right now (someone in progress and the tab visible). */
  polling: boolean;
  failed: boolean;
}

const LiveContext = createContext<LiveState | null>(null);

export function LiveProgressProvider({
  endpoint,
  initial,
  children,
}: {
  /** GET endpoint returning { data: LiveSnapshot }. */
  endpoint: string;
  initial: LiveSnapshot;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(true);
  const [failed, setFailed] = useState(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const inFlight = useRef(false);

  // A router.refresh() re-renders the page with a fresh server snapshot.
  useEffect(() => {
    if (Date.parse(initial.generatedAt) > Date.parse(snapshotRef.current.generatedAt)) {
      setSnapshot(initial);
      setReceivedAt(Date.now());
    }
  }, [initial]);

  const anyoneLive = Object.keys(snapshot.live).length > 0 || snapshot.counts.inProgress > 0;
  // Every 20 s while someone is taking the test (or the page's own load
  // failed); once a minute while nobody is yet but someone hasn't started
  // and the test still takes starts (so a class start shows up).
  const pollMs =
    anyoneLive || snapshot.degraded
      ? LIVE_POLL_MS
      : snapshot.counts.notStarted > 0 && snapshot.acceptingStarts
      ? WAITING_POLL_MS
      : null;
  const polling = anyoneLive && visible;
  const receivedAtRef = useRef(receivedAt);
  receivedAtRef.current = receivedAt;

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(endpoint, { cache: "no-store" });
      const body = res.ok ? ((await res.json().catch(() => null)) as { data?: LiveSnapshot } | null) : null;
      if (!body?.data) {
        setFailed(true);
        return;
      }
      const prev = snapshotRef.current;
      setSnapshot(body.data);
      setReceivedAt(Date.now());
      setFailed(false);
      if (snapshotShapeChanged(prev, body.data)) router.refresh();
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
    }
  }, [endpoint, router]);

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (pollMs == null || !visible) return;
    // Back on the tab after a while: catch up right away.
    if (Date.now() - receivedAtRef.current > pollMs) void poll();
    const timer = setInterval(() => void poll(), pollMs);
    // Countdowns and "Updated 10s ago" while someone is live.
    const tick = anyoneLive ? setInterval(() => setNow(Date.now()), 1000) : null;
    return () => {
      clearInterval(timer);
      if (tick) clearInterval(tick);
    };
  }, [pollMs, visible, anyoneLive, poll]);

  return (
    <LiveContext.Provider value={{ snapshot, receivedAt, now: Math.max(now, receivedAt), polling, failed }}>
      {children}
    </LiveContext.Provider>
  );
}

function useLive() {
  return useContext(LiveContext);
}

/** "3 submitted · 1 in progress · 0 not started" + "● Live · Updated 10s ago". */
export function LiveStatusBar({ className }: { className?: string }) {
  const live = useLive();
  if (!live) return null;
  const { snapshot, receivedAt, now, polling, failed } = live;
  if (snapshot.degraded) {
    return <div className={cn("text-sm text-soft-mute", className)}>Live progress unavailable right now — retrying…</div>;
  }
  const anyoneLive = Object.keys(snapshot.live).length > 0;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-sm", className)}>
      <span className="text-charcoal font-medium">{summaryText(snapshot.counts)}</span>
      {anyoneLive && (
        <span className="inline-flex items-center gap-1.5 text-xs text-soft-mute" aria-live="polite">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              failed ? "bg-status-warning" : polling ? "bg-status-success animate-pulse" : "bg-soft-mute",
            )}
          />
          <span className={cn("font-medium", failed ? "text-status-warning" : polling ? "text-status-success" : "")}>
            {failed ? "Reconnecting" : polling ? "Live" : "Paused"}
          </span>
          <span>· {updatedAgoText(now - receivedAt)}</span>
        </span>
      )}
    </div>
  );
}

const DOT: Record<ConnectionKind, string> = {
  active: "bg-status-success",
  idle: "bg-status-warning",
  offline: "bg-mid-gray",
  unknown: "bg-divider",
};
const DOT_TEXT: Record<ConnectionKind, string> = {
  active: "text-status-success",
  idle: "text-status-warning",
  offline: "text-charcoal font-medium",
  unknown: "text-soft-mute",
};

/**
 * Where an unfinished attempt is: "Module 2 · Q14 · 12:34 left", a bar with
 * "11 / 22 answered", and "Active now" / "Idle 3 min" / "Offline since …".
 * Renders nothing for a finished (or unknown) attempt.
 */
export function LiveProgressCell({ attemptKey, className }: { attemptKey: string; className?: string }) {
  const live = useLive();
  const p = live?.snapshot.live[attemptKey];
  if (!live || !p) return null;
  const elapsed = live.now - live.receivedAt;
  const serverNow = Date.parse(live.snapshot.generatedAt) + elapsed;

  if (p.phase === "break") {
    const left = secondsLeftAfter(p.breakRemainingSeconds, elapsed);
    return (
      <div className={cn("mt-1 text-xs text-mid-gray whitespace-nowrap", className)}>
        On break{left != null ? (left > 0 ? ` · ${timeLeftText(left)}` : " · break over") : ""}
      </div>
    );
  }
  if (p.phase === "between") {
    return <div className={cn("mt-1 text-xs text-mid-gray whitespace-nowrap", className)}>Between modules</div>;
  }

  const position = positionText(p);
  const left = p.notOpened ? null : timeLeftText(secondsLeftAfter(p.remainingSeconds, elapsed));
  const pct = answeredPercent(p.answered, p.total);
  const conn = connectionStatus(p.lastSeenAt, p.lastActiveAt, serverNow);
  return (
    <div className={cn("mt-1 space-y-1 text-xs whitespace-nowrap", className)}>
      <div className="text-charcoal">
        {position ?? "In module"}
        {p.notOpened && <span className="text-soft-mute"> · not opened yet</span>}
        {left && <span className={cn("tabular-nums", left === "Time up" ? "text-status-warning" : "text-mid-gray")}> · {left}</span>}
      </div>
      {p.answered != null && (
        <div className="flex items-center gap-2">
          {pct != null && (
            <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-light-bg" aria-hidden>
              <span className="block h-full rounded-full bg-status-info" style={{ width: `${pct}%` }} />
            </span>
          )}
          <span className="text-mid-gray tabular-nums">
            {p.answered}
            {p.total != null ? ` / ${p.total}` : ""} answered
          </span>
        </div>
      )}
      <div className="flex items-center gap-1.5" title={p.lastSeenAt ? `Last contact ${formatTime(p.lastSeenAt)}` : undefined}>
        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", DOT[conn.kind])} />
        <span className={DOT_TEXT[conn.kind]}>{conn.text}</span>
      </div>
    </div>
  );
}

/** Left-tab count that follows the live snapshot and flashes when it goes up. */
export function LiveTabSwitchCount({ attemptKey, count }: { attemptKey: string; count: number | null }) {
  const live = useLive();
  const p = live?.snapshot.live[attemptKey];
  const value = p ? p.tabSwitches : count;
  const prev = useRef(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (value != null && (before ?? 0) < value) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 6000);
      return () => clearTimeout(t);
    }
  }, [value]);
  return (
    <span
      className={cn(
        "inline-block rounded px-1 -mx-1 transition-colors duration-700",
        flash && "bg-status-warning/20 ring-1 ring-status-warning/40",
      )}
    >
      <TabSwitchCount count={value} />
    </span>
  );
}
