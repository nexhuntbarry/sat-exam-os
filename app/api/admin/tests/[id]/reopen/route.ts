import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { fullLengthPublishModules, loadChildTests } from "@/lib/full-length-admin";
import { moduleApprovalError } from "../../../_shared";

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

  // Students only see Approved questions; don't open a test whose
  // modules would be graded against questions they never saw.
  const { data: test } = await db
    .from("tests")
    .select("module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id, test_kind, parent_test_id")
    .eq("id", id)
    .maybeSingle();
  if (!test) return NextResponse.json({ error: "Test not found" }, { status: 404 });
  // A full-length SAT section follows its parent (sync trigger).
  if (test.parent_test_id || test.test_kind === "fl_section") {
    return NextResponse.json(
      { error: "This is a section of a full-length SAT — reopen the full-length test instead." },
      { status: 409 },
    );
  }
  let approvalErr: string | null;
  if (test.test_kind === "full_length") {
    // Full-length: both sections complete, and every module of both
    // (R&W and Math: M1, M2 easy / hard) fully approved.
    const { children, error: loadErr } = await loadChildTests(db, id);
    if (loadErr) return NextResponse.json({ error: loadErr }, { status: 500 });
    const { moduleIds, error: shapeErr } = fullLengthPublishModules(children);
    approvalErr = shapeErr ?? (await moduleApprovalError(db, moduleIds));
  } else {
    const ids = [test.module_id, test.module_2_id, test.module_1_id, test.module_2_easy_id, test.module_2_hard_id]
      .filter((x): x is string => Boolean(x));
    approvalErr = ids.length === 0
      ? "This test has no modules, so it can't be published."
      : await moduleApprovalError(db, ids);
  }
  if (approvalErr) return NextResponse.json({ error: approvalErr }, { status: 409 });

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
