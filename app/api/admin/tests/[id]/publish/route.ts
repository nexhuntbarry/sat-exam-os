import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { moduleApprovalError } from "../../../_shared";

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

  // Students only see Approved questions; don't open a test whose
  // modules would be graded against questions they never saw.
  const { data: test } = await db
    .from("tests")
    .select("module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id")
    .eq("id", id)
    .maybeSingle();
  if (!test) return NextResponse.json({ error: "Test not found" }, { status: 404 });
  const approvalErr = await moduleApprovalError(
    db,
    [test.module_id, test.module_2_id, test.module_1_id, test.module_2_easy_id, test.module_2_hard_id]
      .filter((x): x is string => Boolean(x)),
  );
  if (approvalErr) return NextResponse.json({ error: approvalErr }, { status: 409 });

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
