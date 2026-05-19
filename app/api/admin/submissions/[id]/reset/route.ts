import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/submissions/[id]/reset
//
// Rolls a submission back to a fresh In-Progress state:
//   - status = "In Progress"
//   - answers = {}
//   - metadata = {}
//   - submitted_at = null
//   - score / correct_count / percentage / scaled_* / time_spent = null/0
//   - started_at = now
//   - deletes every answer_records row tied to this submission
//
// Used by admins when a student got stuck (timer ran out before they
// could submit, browser crashed mid-test, etc.) and we want to let
// them start over WITHOUT losing the submission row (preserves
// attempt history). For a true clean start, use DELETE instead.
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
    .select("id, test_id, student_id")
    .eq("id", id)
    .maybeSingle();
  if (!sub) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }

  // Wipe answer_records first — those mirror the graded state and
  // would otherwise survive into the next attempt.
  await db.from("answer_records").delete().eq("submission_id", id);

  const { error } = await db
    .from("submissions")
    .update({
      status: "In Progress",
      answers: {},
      metadata: {},
      submitted_at: null,
      score: null,
      correct_count: null,
      total_questions: null,
      percentage: null,
      scaled_score: null,
      scaled_section: null,
      time_spent_seconds: 0,
      started_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("[admin/submissions/reset]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
