import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/questions/[id]/needs-review
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
      parsing_status: "Needs Review",
      parsing_notes: reason ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select("id, parsing_status")
    .single();

  if (error) {
    console.error("[questions/needs-review] error:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ data });
}
