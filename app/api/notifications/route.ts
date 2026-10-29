import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { SUPPORT_TYPE } from "@/lib/support";
import { STUDENT_REPORT_TYPE } from "@/lib/student-reports-shared";

// GET /api/notifications — the current user's recent notifications + unread count.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getServiceClient();
  const { data, error } = await db
    .from("notifications")
    .select("id, type, payload, read_at, created_at")
    .eq("user_id", user.userId)
    // A support request row is the thread itself, and a student report is
    // an admin-queue item; neither is a notification for its owner.
    .not("type", "in", `(${SUPPORT_TYPE},${STUDENT_REPORT_TYPE})`)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items = data ?? [];
  const unread = items.filter((n) => !n.read_at).length;
  return NextResponse.json({ items, unread });
}
