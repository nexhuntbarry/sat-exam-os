import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { SUPPORT_TYPE, listSupportRequests, type SupportRequest } from "@/lib/support";
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

  const now = new Date().toISOString();
  const payload: SupportRequest = {
    kind: SUPPORT_TYPE,
    status: "new",
    reporter_name: auth.displayName,
    reporter_email: auth.email,
    messages: [{ from: "reporter", body, at: now, screenshots }],
    updated_at: now,
  };
  const { data, error } = await getServiceClient()
    .from("notifications")
    // read_at is set so the request row never counts as an unread bell item.
    .insert({ user_id: auth.userId, type: SUPPORT_TYPE, payload, read_at: now })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id });
}
