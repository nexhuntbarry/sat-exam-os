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
    refreshing = Promise.resolve(clerk?.session?.getToken?.({ skipCache: true }))
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

export async function waitForImages(
  root: ParentNode = document,
  { timeoutMs = 20000, onProgress, retries = IMAGE_RETRIES }: { timeoutMs?: number; onProgress?: (loaded: number, total: number) => void; retries?: number } = {},
): Promise<{ total: number; failed: string[] }> {
  const imgs = Array.from(root.querySelectorAll("img"));
  let loaded = 0;
  onProgress?.(0, imgs.length);
  const failed: string[] = [];
  await Promise.all(
    imgs.map(async (img) => {
      // A lazy image off-screen would never start loading on its own.
      if (img.loading === "lazy") img.loading = "eager";
      let ok = await loadOnce(img, timeoutMs);
      for (let attempt = 1; !ok && attempt <= retries && /^(?!data:|blob:)./.test(img.getAttribute("src") ?? ""); attempt++) {
        await refreshSession();
        img.src = retrySrc(img.getAttribute("src")!, attempt);
        ok = await loadOnce(img, timeoutMs);
      }
      // Count every settled image (loaded or failed) so the progress
      // reaches total before printing; failures are reported separately.
      if (!ok) failed.push(img.alt || img.currentSrc || img.src);
      onProgress?.(++loaded, imgs.length);
    }),
  );
  return { total: imgs.length, failed };
}

/** Before printing with figures missing: the person has to say so. */
export function confirmPrintWithMissing(failed: string[]): boolean {
  if (failed.length === 0) return true;
  return window.confirm(
    `${failed.length} figure${failed.length === 1 ? "" : "s"} didn't load and will be missing on paper:\n${failed.slice(0, 8).join("\n")}${failed.length > 8 ? "\n…" : ""}\n\nPress Cancel, then reload the page to try again. Press OK to print anyway.`,
  );
}
