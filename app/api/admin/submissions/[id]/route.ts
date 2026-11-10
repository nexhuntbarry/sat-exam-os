import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { deleteFullLengthAttempt } from "@/lib/full-length-attempt";

// DELETE /api/admin/submissions/[id]
//
// Wholesale removes a submission and every answer_record tied to it.
// Use when the student needs a clean re-attempt (no attempt history
// retained). Submission also disappears from teacher results lists.
//
// Cascade: answer_records.submission_id has ON DELETE CASCADE in
// 0001_init_schema, so the delete on submissions wipes them too.
//
// A full-length SAT row deletes the WHOLE full-length attempt (both
// sections' rows and the full_length_attempts row), so no half attempt is
// left behind (lib/full-length-attempt deleteFullLengthAttempt). The
// admin page's confirm says so.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const db = getServiceClient();

  const { data: sub } = await db
    .from("submissions")
    .select("id, student_id, test_id, attempt_number, metadata")
    .eq("id", id)
    .maybeSingle();
  if (!sub) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }
  const crossSide = await forbidCrossSide(auth, { userIds: [sub.student_id], testIds: [sub.test_id] });
  if (crossSide) return crossSide;

  try {
    const fl = await deleteFullLengthAttempt(db, sub);
    if (fl) return NextResponse.json({ ok: true, fullLengthAttempt: true, deleted: fl.deleted });
  } catch (e) {
    console.error("[admin/submissions/delete] full-length", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Delete failed" }, { status: 500 });
  }

  const { error } = await db.from("submissions").delete().eq("id", id);
  if (error) {
    console.error("[admin/submissions/delete]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
