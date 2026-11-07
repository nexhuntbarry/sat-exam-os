import { parseBlobUrl } from "@/lib/blob-url";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Server-side: fetch private Vercel Blob images (either store's token, as in
// /api/blob-image) and return data: URIs, for pages rendered by the server's
// own headless Chromium, which has no session to call the image proxy with.
export async function inlineBlobImages(urls: string[]): Promise<Map<string, string>> {
  const tokens = [process.env.BLOB_READ_WRITE_TOKEN, process.env.PUBLIC_BLOB_READ_WRITE_TOKEN].filter((t): t is string => Boolean(t));
  const out = new Map<string, string>();
  await Promise.all(
    Array.from(new Set(urls)).map(async (url) => {
      // https Vercel Blob only, no userinfo (lib/blob-url) — the tokens go nowhere else.
      const target = parseBlobUrl(url);
      if (!target) return;
      for (const token of tokens.length > 0 ? tokens : [undefined]) {
        const r = await fetch(target, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => null);
        if (r?.ok) {
          const type = r.headers.get("content-type") ?? "image/png";
          if (!type.startsWith("image/")) return;
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > MAX_IMAGE_BYTES) return;
          out.set(url, `data:${type};base64,${buf.toString("base64")}`);
          return;
        }
        if (r && r.status !== 401 && r.status !== 403) return;
      }
    }),
  );
  return out;
}
