import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { finalizeSubmission } from "@/lib/grade-submission";

// POST /api/admin/submissions/[id]/force-submit
//
// Admin variant of /api/student/submissions/[id]/submit. Used when a
// student is locked out, can't trigger submit themselves, but the
// answers they HAVE entered need to be graded and the submission
// closed out. Reads the latest answers from the submission row and
// runs the same grading pipeline.
//
// Does NOT trigger the Module-1 → Module-2 handoff. If admin force-
// submits Module 1 of a two-module test, the student stays parked and
// admin can create the Module 2 submission manually (or by using
// reset on the next attempt).
//
// Grades through lib/grade-submission's finalizeSubmission — the same
// Approved-only question set and answer matching as a student submit.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole("admin");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const db = getServiceClient();

  const { data: submission } = await db
    .from("submissions")
    .select(
      "id, test_id, student_id, answers, started_at, status, module_id, adaptive_track, metadata",
    )
    .eq("id", id)
    .maybeSingle();
  if (!submission) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }
  const crossSide = await forbidCrossSide(auth, { userIds: [submission.student_id], testIds: [submission.test_id] });
  if (crossSide) return crossSide;
  if (submission.status !== "In Progress") {
    return NextResponse.json(
      { error: `Submission already ${submission.status}` },
      { status: 400 },
    );
  }

  const { data: test } = await db
    .from("tests")
    .select("id, module_id, due_date, question_ids, is_adaptive")
    .eq("id", submission.test_id)
    .maybeSingle();
  if (!test) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }

  if (!(submission.module_id ?? test.module_id)) {
    return NextResponse.json(
      { error: "Submission has no module to grade against" },
      { status: 500 },
    );
  }

  let graded;
  try {
    graded = await finalizeSubmission({
      submissionId: id,
      submission: {
        id: submission.id,
        test_id: submission.test_id,
        answers: (submission.answers as Record<string, string> | null) ?? null,
        started_at: submission.started_at,
        module_id: submission.module_id,
        adaptive_track: submission.adaptive_track,
        metadata: submission.metadata,
      },
      test: {
        id: test.id,
        module_id: test.module_id,
        question_ids: (test.question_ids as string[] | null) ?? null,
        is_adaptive: test.is_adaptive,
        due_date: test.due_date,
      },
      db,
    });
  } catch (e) {
    console.error("[admin/submissions/force-submit]", e);
    return NextResponse.json(
      { error: "Failed to finalize submission" },
      { status: 500 },
    );
  }
  if (!graded) {
    return NextResponse.json(
      { error: "Submission was already finalized" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    status: graded.status,
    correctCount: graded.correctCount,
    totalQuestions: graded.totalQuestions,
    percentage: graded.percentage,
  });
}
