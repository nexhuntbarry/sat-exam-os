import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/modules/[id]/parse — stub: marks parsing_status='parsing'
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  const { error } = await db
    .from("modules")
    .update({ parsing_status: "parsing", updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[modules/parse] DB error:", error);
    return NextResponse.json({ error: "Failed to queue parse" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    message: "Parsing queued. Admin will review drafts once AI parse is complete (Phase 1B).",
  });
}
