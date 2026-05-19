import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

// GET /api/blob-image?u=<encoded private blob URL>
// Streams a private Vercel Blob through the function (with auth header)
// so <img src> tags can render private question images. Any authenticated
// app user can fetch — images are only ever question content.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url).searchParams.get("u");
  if (!url) return NextResponse.json({ error: "Missing u" }, { status: 400 });

  // Only allow blob.vercel-storage.com hosts
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return NextResponse.json({ error: "Bad URL" }, { status: 400 });
  }
  if (!target.hostname.endsWith(".blob.vercel-storage.com")) {
    return NextResponse.json({ error: "Forbidden host" }, { status: 403 });
  }

  // Project has two Vercel Blob stores (general + the older "PUBLIC"
  // store from when question images had to be public-readable). Each
  // store has its own read-write token, and a token from store A
  // returns 403 against store B. We try both tokens in order so the
  // proxy works for either store without us having to encode which
  // hostname maps to which token.
  const tokens = [
    process.env.BLOB_READ_WRITE_TOKEN,
    process.env.PUBLIC_BLOB_READ_WRITE_TOKEN,
  ].filter((t): t is string => Boolean(t));

  let upstream: Response | null = null;
  for (const token of tokens.length > 0 ? tokens : [undefined]) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(target.toString(), { headers });
    if (r.ok) {
      upstream = r;
      break;
    }
    upstream = r;
    if (r.status !== 401 && r.status !== 403) break;
  }
  if (!upstream || !upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Upstream ${upstream?.status ?? "no-response"}` },
      { status: upstream?.status === 404 ? 404 : 502 },
    );
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "image/png",
      "Cache-Control": "private, max-age=600",
    },
  });
}
