import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { requireAnyRole } from "@/lib/rbac";

// Generic file upload. Locked down to:
// - PDF (module sources) and PNG/JPEG (formula sheets, profile photos)
// - 20 MB hard cap
// - Caller cannot pick the blob pathname — server forces a per-user
//   prefix and a random suffix to prevent path collisions or
//   overwrites of unrelated blobs.
const ALLOWED_MIME = new Set(["application/pdf", "image/png", "image/jpeg"]);
const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(req: Request) {
  const authResult = await requireAnyRole(["admin", "teacher", "student"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: "Unsupported file type" },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File too large (max 20 MB)" },
      { status: 413 },
    );
  }

  // Strip directory separators and other shell-y chars from the
  // user-provided filename. Server forces the prefix so a caller
  // cannot point this upload at someone else's blob namespace.
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const blobPathname = `uploads/${user.userId}/${Date.now()}-${safeName}`;

  // Project's Blob store is configured private — `put` rejects "public"
  // outright on a private store. Render private blobs through the
  // /api/blob-image proxy when an <img> needs to reach them.
  const blob = await put(blobPathname, file, {
    access: "private",
    addRandomSuffix: true,
  });

  return NextResponse.json({ url: blob.url, size: file.size });
}
