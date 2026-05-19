import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

const SETTING_KEY = "math_formula_sheet";
// Fixed pathname so re-uploads overwrite in place. Vercel Blob requires
// `addRandomSuffix: false` for that to behave like an upsert.
const BLOB_PATH = "formula-sheets/global-math.png";

// GET — return the current global formula sheet URL (or null).
export async function GET() {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const db = getServiceClient();
  const { data } = await db
    .from("app_settings")
    .select("value, updated_at")
    .eq("key", SETTING_KEY)
    .maybeSingle();

  const url = (data?.value as { url?: string } | null)?.url ?? null;
  return NextResponse.json({ url, updatedAt: data?.updated_at ?? null });
}

// POST — admin uploads a new formula sheet. Multipart form with `file`.
export async function POST(req: Request) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const admin = authResult;

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Image required (PNG/JPG)" }, { status: 400 });
  }

  // Vercel Blob retains a stable URL per pathname when addRandomSuffix=false,
  // but to defeat browser caching when the admin swaps the sheet we append
  // a query-string version tag derived from the blob's mtime. Wrap in
  // try/catch so a missing token / network failure surfaces as JSON
  // rather than an unhandled exception (which the client receives as an
  // HTML 500 page and parses as "Unexpected end of JSON input").
  // Project's Blob store is configured private, so we upload private
  // and let the take-page render through /api/blob-image, which streams
  // with the read-write token attached. The cache-busting `?v=` tag
  // still works because the proxy passes the query string upstream.
  let versioned: string;
  try {
    const blob = await put(BLOB_PATH, file, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: file.type,
    });
    versioned = `${blob.url}?v=${Date.now()}`;
  } catch (e) {
    console.error("[admin/settings/formula-sheet PUT blob]", e);
    return NextResponse.json(
      { error: `Blob upload failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  const db = getServiceClient();
  const { error } = await db
    .from("app_settings")
    .upsert({
      key: SETTING_KEY,
      value: { url: versioned },
      updated_at: new Date().toISOString(),
      updated_by: admin.userId,
    });
  if (error) {
    console.error("[admin/settings/formula-sheet POST]", error);
    return NextResponse.json(
      { error: `Failed to save setting: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ url: versioned, size: file.size });
}

// DELETE — clear the global setting (admins can revert to no sheet).
export async function DELETE() {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const db = getServiceClient();
  await db.from("app_settings").delete().eq("key", SETTING_KEY);
  return NextResponse.json({ ok: true });
}
