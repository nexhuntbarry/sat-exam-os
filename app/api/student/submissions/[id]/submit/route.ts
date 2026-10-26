import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
// Single grading path shared with the cron finalizer and admin
// force-submit, so live grading and re-grading can never diverge.
import { finalizeSubmission } from "@/lib/grade-submission";
import {
  isModule2Track,
  mergeAnswers,
  moduleStartedAtIso,
  sanitizeClientMetadata,
  stampModule2Start,
} from "@/lib/student-exam";

// POST /api/student/submissions/[id]/submit
// Optional JSON body:
//   { answers?: Record<questionId,string|null>; answersMode?: "merge";
//     metadata?: object }
// When the client supplies the latest answers in the request body, we use
// them directly and skip the separate autosave PATCH the UI used to fire
// first. Cuts submit latency roughly in half by collapsing two round
// trips into one. answersMode "merge" overlays them on the saved answers
// (null clears one) instead of replacing the whole map.
//
// Submitting after the module deadline (limit + grace) is still accepted
// and graded, but the submission is marked "Late".
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id } = await params;
  const db = getServiceClient();

  // Inline-save body (optional): collapses what used to be a PATCH +
  // POST roundtrip into one POST. If parsing fails or fields are
  // missing we simply skip the save — grading still falls back to the
  // last DB-persisted answers.
  let inlineAnswers: Record<string, string | null> | null = null;
  let inlineMetadata: Record<string, unknown> | null = null;
  let mergeMode = false;
  try {
    const body = (await req.clone().json()) as
      | {
          answers?: Record<string, string | null>;
          answersMode?: string;
          metadata?: Record<string, unknown>;
        }
      | undefined;
    if (body?.answers && typeof body.answers === "object") {
      inlineAnswers = body.answers;
    }
    mergeMode = body?.answersMode === "merge";
    if (body?.metadata && typeof body.metadata === "object") {
      inlineMetadata = sanitizeClientMetadata(body.metadata);
    }
  } catch {
    /* No body / non-JSON → fall back to DB-stored answers. */
  }

  // Fetch submission
  const { data: submission, error: subError } = await db
    .from("submissions")
    .select(
      "id, test_id, student_id, answers, status, started_at, attempt_number, session_id, module_id, adaptive_track, metadata",
    )
    .eq("id", id)
    .eq("student_id", user.userId)
    .single();

  if (subError || !submission) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }

  if (submission.status !== "In Progress") {
    return NextResponse.json({ error: "Submission already submitted" }, { status: 400 });
  }

  // Fetch test. We pull adaptive routing fields too — they're only used
  // when this submission is the Module 1 of an adaptive attempt, but
  // pulling them here keeps the query count down.
  const { data: test, error: testError } = await db
    .from("tests")
    .select(
      "id, module_id, module_2_id, time_limit_minutes, time_limit_minutes_module_2, is_untimed, due_date, question_ids, is_adaptive, module_2_easy_id, module_2_hard_id, adaptive_threshold",
    )
    .eq("id", submission.test_id)
    .single();

  if (testError || !test) {
    return NextResponse.json({ error: "Test not found" }, { status: 500 });
  }

  // Submitting a Module 2 whose clock never started stamps it first (same
  // guarded write as the take page), then the deadline is enforced from
  // that stamp — no unlimited time via a direct API submit.
  let submissionMetadata = submission.metadata as unknown;
  if (isModule2Track(submission.adaptive_track) && !moduleStartedAtIso(submission)) {
    submissionMetadata = await stampModule2Start(db, submission.id, submission.metadata);
  }

  // Prefer the answers the client just sent (latest). Fall back to
  // whatever's in the DB if the client didn't supply any.
  const savedAnswers = (submission.answers ?? {}) as Record<string, string>;
  const answersOverride = inlineAnswers
    ? mergeMode
      ? mergeAnswers(savedAnswers, inlineAnswers)
      : mergeAnswers({}, inlineAnswers)
    : undefined;

  let graded;
  try {
    graded = await finalizeSubmission({
      submissionId: id,
      submission: {
        id: submission.id,
        test_id: submission.test_id,
        answers: savedAnswers,
        started_at: submission.started_at,
        module_id: submission.module_id,
        adaptive_track: submission.adaptive_track,
        metadata: submissionMetadata,
      },
      test: {
        id: test.id,
        module_id: test.module_id,
        question_ids: (test.question_ids as string[] | null) ?? null,
        is_adaptive: test.is_adaptive,
        due_date: test.due_date,
        time_limit_minutes: test.time_limit_minutes,
        time_limit_minutes_module_2: test.time_limit_minutes_module_2,
        is_untimed: test.is_untimed,
      },
      enforceTimeLimit: true,
      answersOverride,
      // Fold inline metadata in here so we don't need the separate PATCH
      // the UI used to send before submit.
      extraUpdates: inlineMetadata
        ? {
            metadata: {
              ...((submissionMetadata ?? {}) as Record<string, unknown>),
              ...inlineMetadata,
            },
          }
        : undefined,
      db,
    });
  } catch (e) {
    console.error("[submit/finalize]", e);
    return NextResponse.json({ error: "Failed to finalize submission" }, { status: 500 });
  }
  // Lost the claim: an overlapping submit (client retry, timer expiry +
  // manual click, cron) already finalized it. Same 400 as a late duplicate.
  if (!graded) {
    return NextResponse.json({ error: "Submission already submitted" }, { status: 400 });
  }
  const { status: finalStatus, correctCount, totalQuestions, percentage, timeSpentSeconds } = graded;

  // Module 1 → Module 2 handoff. Two paths share the same handoff
  // shape (insert a fresh In-Progress submission in the same session),
  // they only differ in how the next module is chosen.
  let nextSubmissionId: string | null = null;
  if (submission.adaptive_track === "module_1" && submission.session_id) {
    let nextModuleId: string | null = null;
    let nextTrack: "module_2" | "module_2_easy" | "module_2_hard" | null = null;

    if (test.is_adaptive) {
      const threshold = test.adaptive_threshold ?? 60;
      const wantHard = percentage >= threshold;
      // Pick the chosen track first, fall back to the other when the
      // chosen one wasn't configured. The start endpoint already
      // refused to launch a test missing both tracks.
      nextModuleId = wantHard
        ? test.module_2_hard_id ?? null
        : test.module_2_easy_id ?? null;
      nextTrack = wantHard ? "module_2_hard" : "module_2_easy";
      if (!nextModuleId) {
        nextModuleId = wantHard
          ? test.module_2_easy_id ?? null
          : test.module_2_hard_id ?? null;
        nextTrack = wantHard ? "module_2_easy" : "module_2_hard";
      }
    } else if (test.module_2_id) {
      // Non-adaptive 2-module test: fixed handoff, no routing decision.
      nextModuleId = test.module_2_id;
      nextTrack = "module_2";
    }

    if (nextModuleId && nextTrack) {
      const { data: nextSub, error: nextErr } = await db
        .from("submissions")
        .insert({
          test_id: submission.test_id,
          student_id: submission.student_id,
          answers: {},
          status: "In Progress",
          started_at: new Date().toISOString(),
          attempt_number: submission.attempt_number,
          metadata: {},
          session_id: submission.session_id,
          module_id: nextModuleId,
          adaptive_track: nextTrack,
        })
        .select("id")
        .single();

      if (nextErr || !nextSub) {
        console.error("[submit/module2_handoff]", nextErr);
        // Module 1 is already graded; refusing now would strand the
        // attempt. Return success without a next-id so the UI lands on
        // Module 1 result and an admin can intervene.
      } else {
        nextSubmissionId = nextSub.id;
      }
    }
  }

  return NextResponse.json({
    data: {
      id,
      status: finalStatus,
      score: correctCount,
      correctCount,
      totalQuestions,
      percentage,
      timeSpentSeconds,
      nextSubmissionId,
    },
  });
}
