"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Coffee, ChevronRight } from "lucide-react";

interface Props {
  /** The full-length (parent) test id. */
  testId: string;
  testName: string;
  /** Server time the break ends (epoch ms). */
  breakEndsAtMs: number;
  /** Server "now" when the page was rendered (epoch ms). */
  serverNowMs: number;
  /** Pausing between sections allowed: no auto start at 0:00. */
  allowPause: boolean;
  /** "35 min" / "52 min 30 s" — Math Module 1's effective limit. */
  mathTimeLabel: string | null;
  mathQuestionCount: number;
}

const SAT_URL = (testId: string) => `/student/tests/${testId}/sat`;

function clock(seconds: number) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Break between Reading and Writing and Math. The countdown is the
// server's (break end − server now), mapped onto this device's clock and
// re-synced from GET .../state whenever the tab regains focus. Math's
// clock only starts when Math Module 1 is created (POST .../start-math):
// "Resume testing" at any time, or — when pausing is off — automatically
// once this screen reaches 0:00 (the server accepts that 2 s early at
// most, otherwise it returns the true remaining time and we re-sync).
// A student who comes back after the break ended sees "Break over" and
// starts Math with its full time; nothing runs while they're away.
export default function BreakScreen({
  testId,
  testName,
  breakEndsAtMs,
  serverNowMs,
  allowPause,
  mathTimeLabel,
  mathQuestionCount,
}: Props) {
  // Break end on this device's clock.
  const [deadline, setDeadline] = useState(() => Date.now() + (breakEndsAtMs - serverNowMs));
  const [remaining, setRemaining] = useState(() => Math.max(0, (breakEndsAtMs - serverNowMs) / 1000));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  // Auto start only when this screen saw the break running (a student who
  // comes back after it ended presses Resume themselves).
  const sawRunning = useRef(breakEndsAtMs - serverNowMs > 0);
  const autoTried = useRef(false);
  useEffect(() => setHydrated(true), []);

  const start = useCallback(
    async (auto: boolean) => {
      setStarting(true);
      setError(null);
      try {
        const res = await fetch(`/api/student/full-length/${testId}/start-math`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(auto ? { auto: true } : {}),
          cache: "no-store",
        });
        const json = (await res.json().catch(() => null)) as
          | { data?: unknown; error?: string; breakEndsAt?: string; now?: string }
          | null;
        if (res.ok && json?.data) {
          window.location.assign(SAT_URL(testId));
          return;
        }
        if (res.status === 409 && json?.breakEndsAt && json.now) {
          // Not over yet on the server (or pausing is on): re-sync.
          setDeadline(Date.now() + (Date.parse(json.breakEndsAt) - Date.parse(json.now)));
          autoTried.current = false;
          if (!auto) setError(json.error ?? "Please try again.");
          setStarting(false);
          return;
        }
        if (res.status === 403 || res.status === 404) {
          // Closed / not available: the page explains why.
          window.location.assign(SAT_URL(testId));
          return;
        }
        throw new Error(json?.error ?? `Server error (${res.status})`);
      } catch (e) {
        setError(
          e instanceof Error && e.message
            ? `${e.message} Check your connection and press Resume testing.`
            : "Couldn't start Math. Check your connection and press Resume testing.",
        );
        setStarting(false);
      }
    },
    [testId],
  );

  // Re-sync with the server's clock (focus, tab shown).
  const resync = useCallback(async () => {
    try {
      const res = await fetch(`/api/student/full-length/${testId}/state`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as {
        data?: { state?: string | null; breakEndsAt?: string | null; now?: string };
      };
      const d = json.data;
      if (!d) return;
      if (d.state && d.state !== "break") {
        // Math was started elsewhere (another tab / device), or the attempt changed.
        window.location.assign(SAT_URL(testId));
        return;
      }
      if (d.breakEndsAt && d.now) setDeadline(Date.now() + (Date.parse(d.breakEndsAt) - Date.parse(d.now)));
    } catch {
      // offline: keep counting on this device
    }
  }, [testId]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void resync();
    };
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [resync]);

  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, (deadline - Date.now()) / 1000);
      setRemaining(left);
      if (left > 0) sawRunning.current = true;
      else if (!allowPause && sawRunning.current && !autoTried.current) {
        autoTried.current = true;
        void start(true);
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [deadline, allowPause, start]);

  const over = remaining <= 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-cream p-4">
      <div className="w-full max-w-md rounded-2xl border border-divider bg-surface p-6 sm:p-8 text-center shadow-sm">
        <Coffee size={40} className="mx-auto text-warm-coral-text" aria-hidden="true" />
        <h1 className="mt-4 text-xl font-semibold text-charcoal">
          {over ? "Break over" : "Reading and Writing submitted — take a break"}
        </h1>
        <p className="mt-1 text-sm text-soft-mute truncate">{testName}</p>

        {!over && (
          <div className="mt-5">
            <div
              className="text-5xl font-bold tabular-nums text-charcoal"
              role="timer"
              aria-live="off"
              aria-label={`Break time left ${clock(remaining)}`}
            >
              {clock(remaining)}
            </div>
            <div className="text-xs text-soft-mute mt-1">Break time left</div>
          </div>
        )}

        <p className="mt-5 text-charcoal">
          Next: Math · Module 1 — {mathQuestionCount} {mathQuestionCount === 1 ? "question" : "questions"}
          {mathTimeLabel ? `, ${mathTimeLabel}` : ""}.
        </p>
        <p className="mt-2 text-sm text-soft-mute">
          {over
            ? "Math's timer starts when you press Resume testing."
            : allowPause
            ? "You may leave and continue later. Math's timer starts only when you press Resume testing."
            : "Stay on this screen — Math starts automatically when the break ends. You can also resume early."}
        </p>

        {error && (
          <p role="alert" className="mt-4 text-sm text-status-error">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => void start(false)}
          disabled={starting || !hydrated}
          className="mt-6 inline-flex items-center gap-2 px-6 py-3 rounded-full bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warm-coral focus-visible:ring-offset-2"
        >
          {starting ? "Starting Math…" : !hydrated ? "Loading…" : "Resume testing"} <ChevronRight size={16} />
        </button>
        {(allowPause || over) && (
          <a
            href={`/student/tests/${testId}`}
            className="mt-4 block text-sm text-soft-mute underline hover:text-charcoal"
          >
            Back to the test page
          </a>
        )}
      </div>
    </div>
  );
}
