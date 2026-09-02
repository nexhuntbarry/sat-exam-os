import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";

// POST /api/notifications/read — mark notifications read.
// Body: { id?: string }  — one id, or omit to mark ALL of the user's read.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let id: string | undefined;
  try {
    const body = (await req.json()) as { id?: string };
    id = body?.id;
  } catch {
    // no body → mark all
  }

  const db = getServiceClient();
  let q = db
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.userId)
    .is("read_at", null);
  if (id) q = q.eq("id", id);
  const { error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
