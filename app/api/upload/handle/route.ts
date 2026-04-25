import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireRole } from "@/lib/rbac";

// POST /api/upload/handle
// Generates short-lived client tokens that allow the browser to upload
// directly to Vercel Blob, bypassing the 4.5 MB Vercel function body limit.
// Admin only — used by the new-module form for large PDF uploads.
export async function POST(req: Request) {
  // Auth check happens here (before generating the token) and again
  // inside onBeforeGenerateToken — the latter runs on every token request.
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // Re-verify admin role inside the token-issuance callback.
        const innerAuth = await requireRole("admin");
        if (innerAuth instanceof NextResponse) {
          throw new Error("Unauthorized");
        }
        return {
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: 50 * 1024 * 1024, // 50 MB headroom
          addRandomSuffix: false,
          // Default token TTL is short (~30s); large PDFs on slow connections
          // exceed it and fail with "Client token has expired". Give 1 hour.
          validUntil: Date.now() + 60 * 60 * 1000,
          tokenPayload: clientPayload ?? JSON.stringify({
            pathname,
            uploadedBy: innerAuth.userId,
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // Vercel Blob calls this from its servers when the upload finishes.
        // Local dev cannot reach localhost, so we keep this as a no-op
        // logger; the client will trigger the parse endpoint after upload().
        console.log("[upload/handle] upload completed:", blob.url, tokenPayload);
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[upload/handle] error:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
