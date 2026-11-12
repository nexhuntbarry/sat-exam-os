import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { blockersMessage, loadTestReadiness } from "@/lib/test-readiness";

// POST /api/admin/tests/[id]/publish — Draft → Published
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
  let readiness;
  try {
    readiness = await loadTestReadiness(db, id);
  } catch (err) {
    console.error("[admin/tests/publish] readiness", err);
    return NextResponse.json({ error: "Could not verify the test" }, { status: 500 });
  }
  if (!readiness) return NextResponse.json({ error: "Test not found" }, { status: 404 });
  // A full-length SAT section follows its parent (sync trigger).
  if (readiness.blockers.some((b) => b.code === "fl_section")) {
    return NextResponse.json(
      { error: "This is a section of a full-length SAT — publish the full-length test instead." },
      { status: 409 },
    );
  }
  if (!readiness.canPublish) {
    return NextResponse.json({ error: blockersMessage(readiness.blockers), blockers: readiness.blockers }, { status: 409 });
  }

  const { data, error } = await db
    .from("tests")
    .update({ status: "Published", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "Draft")
    .select("id");

  if (error) {
    console.error("[admin/tests/publish]", error);
    return NextResponse.json({ error: "Failed to publish test" }, { status: 500 });
  }
  // The status filter makes a wrong-state call a silent no-op; report it.
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "Only Draft tests can be published. Refresh to see the current status." },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true });
}
