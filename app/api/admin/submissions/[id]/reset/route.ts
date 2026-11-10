import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { resetSubmissionMetadata } from "@/lib/student-exam";
import { resetFullLengthEffects } from "@/lib/full-length-attempt";

// POST /api/admin/submissions/[id]/reset
//
// Rolls a submission back to a fresh In-Progress state:
//   - status = "In Progress"
//   - answers = {}
//   - metadata = {} (a full-length row keeps its extended time, attempt
//     link, attempt start and device: resetSubmissionMetadata)
//   - submitted_at = null
//   - score / correct_count / percentage / scaled_* / time_spent = null/0
//   - started_at = now
//   - deletes every answer_records row tied to this submission
//
// Used by admins when a student got stuck (timer ran out before they
// could submit, browser crashed mid-test, etc.) and we want to let
// them start over WITHOUT losing the submission row (preserves
// attempt history). For a true clean start, use DELETE instead.
//
// Resetting the Module 1 row of a two-module / adaptive session resets
// the whole session: the later Module 2 row(s) of the same session_id are
// deleted (answer_records cascade). Otherwise the old graded Module 2
// would sit next to a fresh Module 1, and re-submitting Module 1 would
// hand off to a second Module 2 row. The handoff recreates Module 2 —
// possibly on a different adaptive track — when Module 1 is submitted.
//
// Full-length SAT rows (lib/full-length-attempt resetFullLengthEffects):
// resetting a Reading and Writing module also deletes the attempt's Math
// section and clears its link and any close (the break restarts when R&W
// Module 2 is submitted again); resetting a Math module lifts any close.
// The module itself restarts with its full time (Module 2: from when it
// is opened again). Section-test rows: unchanged.
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
    .select("id, test_id, student_id, session_id, adaptive_track, metadata, attempt_number")
    .eq("id", id)
    .maybeSingle();
  if (!sub) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }
  const crossSide = await forbidCrossSide(auth, { userIds: [sub.student_id], testIds: [sub.test_id] });
  if (crossSide) return crossSide;

  try {
    await resetFullLengthEffects(db, sub);
  } catch (e) {
    console.error("[admin/submissions/reset] full-length", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "Reset failed" }, { status: 500 });
  }

  if (sub.adaptive_track === "module_1" && sub.session_id) {
    const { error: m2Err } = await db
      .from("submissions")
      .delete()
      .eq("session_id", sub.session_id)
      .eq("student_id", sub.student_id)
      .neq("id", id);
    if (m2Err) {
      console.error("[admin/submissions/reset] delete later modules", m2Err);
      return NextResponse.json({ error: m2Err.message }, { status: 500 });
    }
  }

  // Wipe answer_records first — those mirror the graded state and
  // would otherwise survive into the next attempt.
  await db.from("answer_records").delete().eq("submission_id", id);

  // correct_count / total_questions / score / percentage are NOT NULL
  // in the schema (defaults are 0), so reset has to write zeros rather
  // than nulls. scaled_score / scaled_section / submitted_at are
  // nullable and stay null until the next submit.
  const { error } = await db
    .from("submissions")
    .update({
      status: "In Progress",
      answers: {},
      metadata: resetSubmissionMetadata(sub.metadata),
      submitted_at: null,
      score: 0,
      correct_count: 0,
      total_questions: 0,
      percentage: 0,
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
