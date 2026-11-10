import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";

// POST /api/admin/tests/[id]/close — Published → Closed
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;
  const db = getServiceClient();

  // A full-length SAT section follows its parent (sync trigger).
  const { data: row } = await db.from("tests").select("test_kind, parent_test_id").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Test not found" }, { status: 404 });
  if (row.parent_test_id || row.test_kind === "fl_section") {
    return NextResponse.json(
      { error: "This is a section of a full-length SAT — close the full-length test instead." },
      { status: 409 },
    );
  }

  const { data, error } = await db
    .from("tests")
    .update({ status: "Closed", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "Published")
    .select("id");

  if (error) {
    console.error("[admin/tests/close]", error);
    return NextResponse.json({ error: "Failed to close test" }, { status: 500 });
  }
  // The status filter makes a wrong-state call a silent no-op; report it.
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "Only Published tests can be closed. Refresh to see the current status." },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true });
}
