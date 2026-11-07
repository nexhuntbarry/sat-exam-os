"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  TAKE_ERROR_MAX_RELOADS,
  bumpTakeErrorReloads,
  readTakeErrorReloads,
} from "@/lib/take-error-reloads";

// The take page (Module 1, the Module 2 intro, or Module 2 itself) failed
// to load — usually a dropped connection or a slow database moment. Never
// leave the student on a blank error: say their work is safe and give a
// button that reloads the page (a full reload re-runs the Module 2
// handoff recovery on the server). Answers are kept on this device by the
// take page and re-sent when it loads again.
//
// No reload loop: after TAKE_ERROR_MAX_RELOADS failed reloads (counter in
// lib/take-error-reloads, cleared when the page loads fine) only the way
// back to the test page and "contact your teacher" remain. The app has no
// client error reporting service, so the error goes to the console; its
// digest (shown on screen) matches the server log entry.
export default function TakeError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  const params = useParams<{ id: string }>();
  const testId = params?.id;
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    console.error("[take] page failed to load", error);
    setReloads(readTakeErrorReloads(testId));
  }, [error, testId]);

  function handleContinue() {
    bumpTakeErrorReloads(testId);
    window.location.reload();
  }

  const givenUp = reloads >= TAKE_ERROR_MAX_RELOADS;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-cream p-4">
      <div
        role="alert"
        className="w-full max-w-md rounded-2xl border border-divider bg-surface p-6 sm:p-8 text-center shadow-sm"
      >
        <h1 className="text-xl font-semibold text-charcoal">Your test didn&apos;t load</h1>
        <p className="mt-3 text-charcoal">
          This is usually a connection problem. Your answers are kept on this device.
        </p>
        {givenUp ? (
          <p className="mt-2 text-sm text-soft-mute">
            It still isn&apos;t loading. Please contact your teacher
            {error.digest ? " and tell them the error code below" : " and tell them what time this happened"}.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-soft-mute">
              Press Continue to pick up where you left off. If you just finished Module 1, this opens Module 2.
            </p>
            <button
              type="button"
              onClick={handleContinue}
              className="mt-6 inline-flex items-center gap-2 px-6 py-3 rounded-full bg-warm-coral hover:bg-warm-coral-dark text-white font-semibold transition-colors"
            >
              Continue test
            </button>
          </>
        )}
        {testId && (
          <a
            href={`/student/tests/${testId}`}
            className="mt-4 block text-sm text-soft-mute underline hover:text-charcoal"
          >
            Back to the test page
          </a>
        )}
        {error.digest && <p className="mt-4 text-xs text-soft-mute">Error code: {error.digest}</p>}
      </div>
    </div>
  );
}
