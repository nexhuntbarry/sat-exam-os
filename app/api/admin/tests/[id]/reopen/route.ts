import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { blockersMessage, loadPublishCheck } from "@/lib/test-readiness";

// POST /api/admin/tests/[id]/reopen — Closed → Published
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

  // Same rules as the Tests list's publish confirm (lib/test-readiness):
  // every module fully approved (students only see Approved questions), a
  // full-length test both two-module sections. Being unassigned is only a
  // warning there, never a refusal here.
  let check;
  try {
    check = await loadPublishCheck(db, id);
  } catch (err) {
    console.error("[admin/tests/reopen] publish check", err);
    return NextResponse.json({ error: "Could not verify the test" }, { status: 500 });
  }
  if (!check) return NextResponse.json({ error: "Test not found" }, { status: 404 });
  // A full-length SAT section follows its parent (sync trigger).
  if (check.blockers.some((b) => b.code === "fl_section")) {
    return NextResponse.json(
      { error: "This is a section of a full-length SAT — reopen the full-length test instead." },
      { status: 409 },
    );
  }
  if (!check.canPublish) {
    return NextResponse.json({ error: blockersMessage(check.blockers), blockers: check.blockers }, { status: 409 });
  }

  const { data, error } = await db
    .from("tests")
    .update({ status: "Published", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "Closed")
    .select("id");

  if (error) {
    console.error("[admin/tests/reopen]", error);
    return NextResponse.json({ error: "Failed to reopen test" }, { status: 500 });
  }
  // The status filter makes a wrong-state call a silent no-op; report it.
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "Only Closed tests can be reopened. Refresh to see the current status." },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true });
}
