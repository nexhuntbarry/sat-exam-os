// lib/blob-url.ts
//
// Server-side fetches of stored files attach the Vercel Blob read-write
// token. Only send it (and only fetch at all) when the URL really is an
// https Vercel Blob URL — a substring check on the raw string would let
// "https://evil.example/?x=.blob.vercel-storage.com" receive the token.
// All stored question images and module PDFs live on Vercel Blob.

const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";

/** Parsed URL when it is https on a *.blob.vercel-storage.com host; else null. */
export function parseBlobUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!u.hostname.endsWith(BLOB_HOST_SUFFIX)) return null;
  if (u.username || u.password) return null;
  return u;
}

export function isBlobUrl(raw: unknown): boolean {
  return parseBlobUrl(raw) !== null;
}
