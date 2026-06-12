import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/bug-reports/[id]/resolve
//
// Admin-side "mark resolved" toggle. Used from the bug-reports list
// page when the dev (human) has fixed something the auto-resolver
// couldn't and wants to close the row.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const db = getServiceClient();
  const { error } = await db
    .from("bug_reports")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by: auth.userId,
    })
    .eq("id", id);
  if (error) {
    return NextResponse.json(
      { ok: false, message: error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
