"use client";

import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { clsx } from "clsx";

interface TestTimerProps {
  initialSeconds: number;
  onExpire: () => void;
  /** Called once when the countdown crosses 5 and 1 minute(s) left. */
  onWarning?: (minutesLeft: 5 | 1) => void;
}

export default function TestTimer({ initialSeconds, onExpire, onWarning }: TestTimerProps) {
  const [secondsLeft, setSecondsLeft] = useState(initialSeconds);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  const onWarningRef = useRef(onWarning);
  onWarningRef.current = onWarning;
  const prevSecondsRef = useRef(initialSeconds);

  // Fire on the crossing only, so a reload with < 5 min left doesn't
  // re-announce the 5-minute warning.
  useEffect(() => {
    const prev = prevSecondsRef.current;
    prevSecondsRef.current = secondsLeft;
    if (prev > 300 && secondsLeft <= 300 && secondsLeft > 60) onWarningRef.current?.(5);
    if (prev > 60 && secondsLeft <= 60 && secondsLeft > 0) onWarningRef.current?.(1);
  }, [secondsLeft]);

  // Count down to a fixed wall-clock deadline instead of decrementing
  // per tick: throttled background tabs and sleeping laptops skip ticks,
  // and a slow clock would let the student work past the server's
  // deadline (saves are rejected 60s after it).
  useEffect(() => {
    const deadline = Date.now() + initialSeconds * 1000;
    let expired = false;
    function tick() {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0 && !expired) {
        expired = true;
        clearInterval(interval);
        onExpireRef.current();
      }
    }
    const interval = setInterval(tick, 1000);
    function onVisible() {
      if (document.visibilityState === "visible") tick();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    tick();
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hours = Math.floor(secondsLeft / 3600);
  const minutes = Math.floor((secondsLeft % 3600) / 60);
  const seconds = secondsLeft % 60;

  const pad = (n: number) => String(n).padStart(2, "0");
  const display = hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;

  const isWarning = secondsLeft <= 300; // last 5 minutes
  const isCritical = secondsLeft <= 60; // last minute

  return (
    <div
      role="timer"
      aria-label={`Time remaining ${display}`}
      className={clsx(
        "flex items-center justify-center gap-2 min-w-[5.5rem] px-3 py-1.5 tabular-nums whitespace-nowrap rounded-lg font-mono font-semibold text-sm transition-colors",
        isCritical
          ? "bg-status-error/15 text-status-error animate-pulse"
          : isWarning
          ? "bg-status-warning/15 text-status-warning"
          : "bg-light-bg text-charcoal"
      )}
    >
      <Clock size={14} aria-hidden="true" />
      {display}
    </div>
  );
}
