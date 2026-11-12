import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { loadChildTests } from "@/lib/full-length-admin";
import { testHasSubmissions } from "@/lib/test-readiness";

const STARTED = "Students have already started this test, so it can't go back to Draft. Close it instead.";

// POST /api/admin/tests/[id]/draft — Published / Closed → Draft, only while
// no student has started it (no submission, no full-length attempt).
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

  const { data: row } = await db.from("tests").select("status, test_kind, parent_test_id").eq("id", id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Test not found" }, { status: 404 });
  // A full-length SAT section follows its parent (sync trigger).
  if (row.parent_test_id || row.test_kind === "fl_section") {
    return NextResponse.json(
      { error: "This is a section of a full-length SAT — change the full-length test instead." },
      { status: 409 },
    );
  }
  if (row.status !== "Published" && row.status !== "Closed") {
    return NextResponse.json(
      { error: "Only Published or Closed tests can go back to Draft. Refresh to see the current status." },
      { status: 409 },
    );
  }

  const started = async () => {
    if (row.test_kind !== "full_length") return testHasSubmissions(db, id, null);
    const { children, error: loadErr } = await loadChildTests(db, id);
    if (loadErr) throw new Error(loadErr);
    return testHasSubmissions(db, id, Object.values(children).flatMap((c) => (c ? [c.id] : [])));
  };
  try {
    if (await started()) return NextResponse.json({ error: STARTED }, { status: 409 });
  } catch (err) {
    console.error("[admin/tests/draft] submissions", err);
    return NextResponse.json({ error: "Could not check for submissions" }, { status: 500 });
  }

  const { data, error } = await db
    .from("tests")
    .update({ status: "Draft", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", row.status)
    .select("id");
  if (error) {
    console.error("[admin/tests/draft]", error);
    return NextResponse.json({ error: "Failed to move the test back to Draft" }, { status: 500 });
  }
  // The status filter makes a wrong-state call a silent no-op; report it.
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "The test's status changed meanwhile. Refresh to see the current status." },
      { status: 409 },
    );
  }

  // A student may have started between the check and the update: put the
  // status back rather than leave a started test in Draft.
  let lateStart = true;
  try {
    lateStart = await started();
  } catch (err) {
    console.error("[admin/tests/draft] re-check", err);
  }
  if (lateStart) {
    await db.from("tests").update({ status: row.status, updated_at: new Date().toISOString() }).eq("id", id).eq("status", "Draft");
    return NextResponse.json({ error: STARTED }, { status: 409 });
  }

  return NextResponse.json({ success: true });
}
