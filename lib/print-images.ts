// Client-side: wait until every <img> under root has loaded and decoded, so
// window.print() never snapshots a page whose figures are still in flight
// (a print snapshot draws nothing for an image that hasn't arrived).
// Resolves with the images that failed or timed out (alt text or URL).
//
// Figures come through /api/blob-image, which is authorised by Clerk's
// session cookie — a JWT that lives 60 seconds. An <img> request sent while
// it has lapsed (a laptop waking from sleep, a tab resumed, a long render)
// gets 401 and the browser never asks again: the figure is simply missing
// on paper. A failed image is therefore retried after the session token
// has been refreshed, with a cache-busting URL so the 401 isn't reused.

export const IMAGE_RETRIES = 2;

/** The same image URL with a retry marker, so the browser fetches it again. */
export function retrySrc(src: string, attempt: number): string {
  const [base, hash = ""] = src.split("#", 2);
  const cleaned = base.replace(/([?&])_retry=\d+(&|$)/, (_m, pre: string, post: string) => (post ? pre : "")).replace(/[?&]$/, "");
  const sep = cleaned.includes("?") ? "&" : "?";
  return `${cleaned}${sep}_retry=${attempt}${hash ? `#${hash}` : ""}`;
}

/** Ask Clerk for a fresh session token (it rewrites the session cookie). */
let refreshing: Promise<void> | null = null;
export function refreshSession(): Promise<void> {
  if (!refreshing) {
    const clerk = (globalThis as { Clerk?: { session?: { getToken?: (o: { skipCache: boolean }) => Promise<unknown> } | null } }).Clerk;
    // Capped at 5 s: a hung token refresh on a bad network must not leave
    // the preview on "Loading images…" forever.
    refreshing = Promise.race([
      Promise.resolve(clerk?.session?.getToken?.({ skipCache: true })),
      new Promise((res) => setTimeout(res, 5000)),
    ])
      .then(() => undefined, () => undefined)
      .finally(() => setTimeout(() => (refreshing = null), 5000));
  }
  return refreshing;
}

function loadOnce(img: HTMLImageElement, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    (img.complete ? Promise.resolve() : new Promise<void>((res, rej) => {
      img.addEventListener("load", () => res(), { once: true });
      img.addEventListener("error", () => rej(new Error("error")), { once: true });
    }))
      // Bounded: decode() can be deferred in a background tab; a loaded
      // image is printable either way (naturalWidth is the real check).
      .then(() => Promise.race([img.decode().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]))
      .then(() => img.naturalWidth > 0),
    new Promise<boolean>((res) => setTimeout(() => res(false), timeoutMs)),
  ]).catch(() => false);
}

// A retry follows a fresh session; if it still hangs, give up sooner so a
// stuck proxy can't push the server PDF past its render limit.
const RETRY_TIMEOUT_MS = 6000;

// Overall cap so a single hanging image (network flakiness, never-firing
// load/error) can't keep the Print button disabled past this limit.
// Worst case without it: 20 s initial + 2 × (5 s session + 6 s retry) = 42 s.
// With it, Print is enabled within overallTimeoutMs; any images still pending
// at cutoff are added to `failed`, keeping the missing-figure warning honest.
export const OVERALL_TIMEOUT_MS = 25_000;

export async function waitForImages(
  root: ParentNode = document,
  {
    timeoutMs = 20000,
    onProgress,
    retries = IMAGE_RETRIES,
    overallTimeoutMs = OVERALL_TIMEOUT_MS,
  }: {
    timeoutMs?: number;
    onProgress?: (loaded: number, total: number) => void;
    retries?: number;
    overallTimeoutMs?: number;
  } = {},
): Promise<{ total: number; failed: string[] }> {
  const imgs = Array.from(root.querySelectorAll("img"));
  let loaded = 0;
  onProgress?.(0, imgs.length);
  const failed: string[] = [];
  // Outcome per image: null = still running, true = loaded, false = failed.
  const results: (boolean | null)[] = new Array(imgs.length).fill(null);
  // Whether the image was already counted in progress/failed by its own callback.
  const counted: boolean[] = new Array(imgs.length).fill(false);

  let cutoff = false;
  let cutoffTimer: ReturnType<typeof setTimeout> | undefined;
  const cutoffPromise = new Promise<void>((res) => {
    cutoffTimer = setTimeout(() => { cutoff = true; res(); }, overallTimeoutMs);
  });

  await Promise.race([
    Promise.all(
      imgs.map(async (img, i) => {
        // A lazy image off-screen would never start loading on its own.
        if (img.loading === "lazy") img.loading = "eager";
        let ok = await loadOnce(img, timeoutMs);
        for (let attempt = 1; !ok && !cutoff && attempt <= retries && /^(?!data:|blob:)./.test(img.getAttribute("src") ?? ""); attempt++) {
          await refreshSession();
          if (cutoff) break;
          img.src = retrySrc(img.getAttribute("src")!, attempt);
          ok = await loadOnce(img, Math.min(timeoutMs, RETRY_TIMEOUT_MS));
        }
        results[i] = ok;
        // After the overall cutoff the cleanup loop below owns progress + failed.
        if (cutoff) return;
        counted[i] = true;
        // Count every settled image (loaded or failed) so the progress
        // reaches total before printing; failures are reported separately.
        if (!ok) failed.push(img.alt || img.currentSrc || img.src);
        onProgress?.(++loaded, imgs.length);
      }),
    ),
    cutoffPromise,
  ]);
  clearTimeout(cutoffTimer);

  // Images not counted by their own callback were cut off by the overall
  // timer. One that settled successfully in that instant counts as loaded;
  // anything else is reported missing. An image that finishes loading later
  // still shows on the page, but stays listed as missing for this print.
  for (let i = 0; i < imgs.length; i++) {
    if (counted[i]) continue;
    if (results[i] !== true) failed.push(imgs[i].alt || imgs[i].currentSrc || imgs[i].src);
    onProgress?.(++loaded, imgs.length);
  }

  return { total: imgs.length, failed };
}

/** Before printing with figures missing: the person has to say so. */
export function confirmPrintWithMissing(failed: string[]): boolean {
  if (failed.length === 0) return true;
  return window.confirm(
    `${failed.length} figure${failed.length === 1 ? "" : "s"} didn't load and will be missing on paper:\n${failed.slice(0, 8).join("\n")}${failed.length > 8 ? "\n…" : ""}\n\nPress Cancel, then reload the page to try again. Press OK to print anyway.`,
  );
}
