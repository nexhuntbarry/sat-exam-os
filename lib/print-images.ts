// Client-side: wait until every <img> under root has loaded and decoded, so
// window.print() never snapshots a page whose figures are still in flight
// (a print snapshot draws nothing for an image that hasn't arrived).
// Resolves with the images that failed or timed out (alt text or URL).
export async function waitForImages(
  root: ParentNode = document,
  { timeoutMs = 20000, onProgress }: { timeoutMs?: number; onProgress?: (loaded: number, total: number) => void } = {},
): Promise<{ total: number; failed: string[] }> {
  const imgs = Array.from(root.querySelectorAll("img"));
  let loaded = 0;
  onProgress?.(0, imgs.length);
  const failed: string[] = [];
  await Promise.all(
    imgs.map(async (img) => {
      // A lazy image off-screen would never start loading on its own.
      if (img.loading === "lazy") img.loading = "eager";
      const ok = await Promise.race([
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
      // Count every settled image (loaded or failed) so the progress
      // reaches total before printing; failures are reported separately.
      if (!ok) failed.push(img.alt || img.currentSrc || img.src);
      onProgress?.(++loaded, imgs.length);
    }),
  );
  return { total: imgs.length, failed };
}
