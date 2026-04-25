import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireRole } from "@/lib/rbac";

// POST /api/upload/handle
// Generates short-lived client tokens that allow the browser to upload
// directly to Vercel Blob, bypassing the 4.5 MB Vercel function body limit.
// Two body types arrive at this endpoint:
//   1. blob.generate-client-token — from the browser, must be admin-authed
//   2. blob.upload-completed       — from Vercel Blob's servers, signed via
//      x-vercel-signature header. handleUpload verifies the signature
//      internally — gating with Clerk auth here would 401 the callback and
//      cause the SDK to retry forever.
export async function POST(req: Request) {
  console.log("[upload/handle] POST received");

  const body = (await req.json()) as HandleUploadBody;
  console.log("[upload/handle] body type:", body.type);

  if (body.type === "blob.generate-client-token") {
    const authResult = await requireRole("admin");
    if (authResult instanceof NextResponse) {
      console.warn("[upload/handle] token request auth failed", authResult.status);
      return authResult;
    }
    console.log("[upload/handle] token auth ok userId=", authResult.userId);
  } else {
    console.log("[upload/handle] callback received, skipping Clerk auth (signature-verified)");
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const innerAuth = await requireRole("admin");
        if (innerAuth instanceof NextResponse) {
          throw new Error("Unauthorized");
        }
        return {
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: 50 * 1024 * 1024,
          addRandomSuffix: false,
          validUntil: Date.now() + 60 * 60 * 1000,
          tokenPayload: clientPayload ?? JSON.stringify({
            pathname,
            uploadedBy: innerAuth.userId,
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log("[upload/handle] onUploadCompleted url=", blob.url, "payload=", tokenPayload);
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[upload/handle] error:", message);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
