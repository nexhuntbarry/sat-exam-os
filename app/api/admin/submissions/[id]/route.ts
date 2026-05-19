import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// DELETE /api/admin/submissions/[id]
//
// Wholesale removes a submission and every answer_record tied to it.
// Use when the student needs a clean re-attempt (no attempt history
// retained). Submission also disappears from teacher results lists.
//
// Cascade: answer_records.submission_id has ON DELETE CASCADE in
// 0001_init_schema, so the delete on submissions wipes them too.
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
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!sub) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }

  const { error } = await db.from("submissions").delete().eq("id", id);
  if (error) {
    console.error("[admin/submissions/delete]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
