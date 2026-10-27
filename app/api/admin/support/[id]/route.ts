import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { addSupportMessage, getSupportRequest } from "@/lib/support";
import { uploadScreenshots } from "../upload";

// POST /api/admin/support/[id] — the reporter adds a follow-up message
// (multipart: `body` + optional `screenshots`). Re-opens a fixed/closed
// request so the dev picks it up again.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const db = getServiceClient();
  const row = await getSupportRequest(db, id);
  if (!row || row.user_id !== auth.userId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const form = await req.formData();
  const body = String(form.get("body") ?? "").trim();
  if (!body) return NextResponse.json({ error: "Message is empty" }, { status: 400 });
  if (body.length > 5000) return NextResponse.json({ error: "Message is too long (5000 characters max)" }, { status: 400 });

  let screenshots: string[];
  try {
    const r = await uploadScreenshots(form);
    if (typeof r === "string") return NextResponse.json({ error: r }, { status: 400 });
    screenshots = r;
  } catch (e) {
    console.error("[admin/support/:id POST blob]", e);
    return NextResponse.json({ error: "Screenshot upload failed, please try again" }, { status: 500 });
  }

  const reopen = row.payload.status === "fixed" || row.payload.status === "declined";
  try {
    await addSupportMessage(db, row, { from: "reporter", body, screenshots }, reopen ? "new" : undefined);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
