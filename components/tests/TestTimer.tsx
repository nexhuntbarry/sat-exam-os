"use client";

import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { clsx } from "clsx";

interface TestTimerProps {
  initialSeconds: number;
  onExpire: () => void;
}

export default function TestTimer({ initialSeconds, onExpire }: TestTimerProps) {
  const [secondsLeft, setSecondsLeft] = useState(initialSeconds);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    if (secondsLeft <= 0) {
      onExpireRef.current();
      return;
    }
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval);
          onExpireRef.current();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
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
      className={clsx(
        "flex items-center gap-2 px-3 py-1.5 rounded-lg font-mono font-semibold text-sm transition-colors",
        isCritical
          ? "bg-status-error/15 text-status-error animate-pulse"
          : isWarning
          ? "bg-status-warning/15 text-status-warning"
          : "bg-light-bg text-charcoal"
      )}
    >
      <Clock size={14} />
      {display}
    </div>
  );
}
