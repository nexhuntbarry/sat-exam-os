// lib/submit-recovery.ts
//
// Pure rules the take page (TestTakingClient) uses to get a student from
// "Submitting…" to the next page whatever the network does. Kept free of
// React / DOM so .omc/qa/unit/submit-recovery.test.ts can test them.

/** One submit request (headers + body) may take this long before it's cut. */
export const SUBMIT_TIMEOUT_MS = 20_000;
/** An autosave request may take this long; then it's retried like a failure. */
export const SAVE_TIMEOUT_MS = 20_000;
/** Clerk's token refresh (after a 401) may take this long. */
export const TOKEN_REFRESH_TIMEOUT_MS = 8_000;

/**
 * Once the browser was told to open the next page (Module 2 / the result),
 * give that page this long to arrive before starting the navigation again.
 * A new location.assign() cancels the one still waiting for its response,
 * so restarting it every few seconds (what the old watchdog did on each 5 s
 * poll) meant a page slower than that — a cold server, a class auto-
 * submitting at once, a slow school network — never arrived at all.
 */
export const NAVIGATION_RESTART_MS = 45_000;

/** Background submit retries: 5 s, 10 s, 20 s, 40 s, then every 60 s. */
export const SUBMIT_BACKGROUND_RETRY_MAX_MS = 60_000;
/** After this many background retries the message tells the student to get
 *  their teacher; retrying still goes on (every 60 s) until it lands. */
export const SUBMIT_BACKGROUND_RETRY_WARN_AFTER = 10;

export function submitBackgroundRetryDelayMs(retriesSoFar: number): number {
  const n = Math.max(0, Math.floor(retriesSoFar));
  return Math.min(SUBMIT_BACKGROUND_RETRY_MAX_MS, 5000 * 2 ** Math.min(n, 10));
}

export type SubmitOutcome =
  /** The module is submitted (now or earlier): go to the next page. */
  | "done"
  /** Signed out: stay, keep the answers, ask the student to sign in. */
  | "auth"
  /** The exam row was deleted: nothing left to submit. */
  | "gone"
  /** Worth retrying (network, 5xx, a non-JSON reply). */
  | "transient"
  /** A retry can't fix it (404 test, 422 misconfigured…). */
  | "permanent";

/**
 * What a submit reply means. `res === null`: no reply at all (network error
 * or timeout). `jsonOk`: 2xx with a JSON body — a signed-out request used to
 * come back as a 200 HTML page and must not count as success.
 */
export function classifySubmitResponse(
  res: { status: number; jsonOk: boolean } | null,
  payload: { data?: { id?: string } | null; alreadySubmitted?: boolean; code?: string } | null,
): SubmitOutcome {
  if (!res) return "transient";
  if (res.status === 401) return "auth";
  // 400 "already submitted": an earlier request of ours landed but its reply
  // was lost, or the time-up job graded it first. The module is done.
  if (res.status === 400 && payload) return "done";
  if (res.jsonOk && payload?.data?.id) return "done";
  if (res.status === 404 && payload?.code === "submission_gone") return "gone";
  if (res.status >= 500 || res.status === 408 || res.status === 429) return "transient";
  if (res.status >= 200 && res.status < 300) return "transient"; // 2xx but not the JSON we expect
  return "permanent";
}

/**
 * The submit watchdog's decision on each tick while "Submitting…" shows.
 * - navigating: the page already asked for the next page `sinceMs` ago.
 *   Leave it alone until NAVIGATION_RESTART_MS, then start it once more.
 * - otherwise: ask the server whether the submit landed.
 */
export function watchdogAction(
  navigation: { sinceMs: number; restarts?: number } | null,
): "wait-for-page" | "restart-navigation" | "check-server" {
  if (!navigation) return "check-server";
  // Each restart waits twice as long (45 s, 90 s, 180 s… capped at 6 min), so a
  // page that is merely very slow (a whole class auto-submitting at 0:00) is
  // never cancelled over and over at a fixed interval.
  const wait = Math.min(NAVIGATION_RESTART_MS * 2 ** (navigation.restarts ?? 0), 6 * 60_000);
  return navigation.sinceMs >= wait ? "restart-navigation" : "wait-for-page";
}

/**
 * Resolve `work` or reject after `ms` / when `signal` aborts — for awaits
 * that take no AbortSignal themselves (Clerk's getToken), so a hung one
 * can't hold a submit past its timeout.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, signal?: AbortSignal | null): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new Error("aborted")));
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    work.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}
