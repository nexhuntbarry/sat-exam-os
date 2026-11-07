import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { createSupportRequest, listSupportRequests } from "@/lib/support";
import { uploadScreenshots } from "./upload";

// GET /api/admin/support — the current admin's own problem reports.
export async function GET() {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  try {
    return NextResponse.json({ items: await listSupportRequests(getServiceClient(), auth.userId) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// POST /api/admin/support — multipart: `body` (text) + `screenshots` (images).
export async function POST(req: Request) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;

  const form = await req.formData();
  const body = String(form.get("body") ?? "").trim();
  if (!body) return NextResponse.json({ error: "Describe the problem" }, { status: 400 });
  if (body.length > 5000) return NextResponse.json({ error: "Description is too long (5000 characters max)" }, { status: 400 });

  let screenshots: string[];
  try {
    const r = await uploadScreenshots(form);
    if (typeof r === "string") return NextResponse.json({ error: r }, { status: 400 });
    screenshots = r;
  } catch (e) {
    console.error("[admin/support POST blob]", e);
    return NextResponse.json({ error: "Screenshot upload failed, please try again" }, { status: 500 });
  }

  try {
    const id = await createSupportRequest(getServiceClient(), {
      userId: auth.userId,
      reporterName: auth.displayName,
      reporterEmail: auth.email,
      body,
      screenshots,
    });
    return NextResponse.json({ id });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
