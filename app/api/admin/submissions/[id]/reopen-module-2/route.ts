import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { reopenModule2 } from "@/lib/module2-reopen";

// POST /api/admin/submissions/[id]/reopen-module-2
//
// Admin "Reopen Module 2…" on the test's Students table / Submissions page
// (ticket 969e0414). [id] is the graded Module 2 row. Module 1 is kept;
// Module 2 goes back to a fresh, unopened handoff (same track), and its
// timer starts when the student presses Start. Rules: lib/module2-reopen.
// Admins only, like the other submission manage actions.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const db = getServiceClient();

  const { data: sub } = await db
    .from("submissions")
    .select("id, student_id, test_id")
    .eq("id", id)
    .maybeSingle();
  if (!sub) return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  const crossSide = await forbidCrossSide(auth, { userIds: [sub.student_id], testIds: [sub.test_id] });
  if (crossSide) return crossSide;

  try {
    const r = await reopenModule2(db, id);
    if (!r.ok) return NextResponse.json({ error: r.error, reason: r.reason }, { status: r.status });
    return NextResponse.json({ ok: true, track: r.track });
  } catch (e) {
    console.error("[admin/submissions/reopen-module-2]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Reopen failed" }, { status: 500 });
  }
}
