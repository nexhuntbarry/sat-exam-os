import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/questions/[id]/reject
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const reason: string | null = body.reason ?? null;

  const db = getServiceClient();

  const { data, error } = await db
    .from("questions")
    .update({
      parsing_status: "Rejected",
      parsing_notes: reason
        ? `Rejected: ${reason}`
        : "Rejected by admin",
      reviewed_by: authResult.userId,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, parsing_status")
    .single();

  if (error) {
    console.error("[questions/reject] error:", error);
    return NextResponse.json({ error: "Reject failed" }, { status: 500 });
  }

  return NextResponse.json({ data });
}
