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
  applyQuestionMeta,
  sanitizeClientMetadata,
  stampModule2Start,
  deviceInfoFromHeaders,
} from "@/lib/student-exam";
import { ensureModule2, findModule2, recoverModule2, RECOVERY_TEST_COLUMNS } from "@/lib/module2-handoff";

// Grading + answer_records + the Module 2 handoff can take a while on a
// slow Supabase moment; don't let the default limit cut a submit short.
export const maxDuration = 60;

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
//
// Module 1 of a two-module test: the response carries nextSubmissionId
// (the Module 2 row, created idempotently by lib/module2-handoff). A
// submit that finds Module 1 already graded (cron closed it, or an
// earlier request landed) still answers 400 "already submitted", but
// with alreadySubmitted + nextSubmissionId so the client can continue to
// Module 2. handoffFailed: Module 1 is graded but Module 2 couldn't be
// created even after a retry; the take page retries the handoff.
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
  let inlineQuestionMeta: Record<string, unknown> | null = null;
  let mergeMode = false;
  try {
    const body = (await req.clone().json()) as
      | {
          answers?: Record<string, string | null>;
          answersMode?: string;
          metadata?: Record<string, unknown>;
          questionMeta?: Record<string, unknown>;
        }
      | undefined;
    if (body?.answers && typeof body.answers === "object") {
      inlineAnswers = body.answers;
    }
    mergeMode = body?.answersMode === "merge";
    if (body?.metadata && typeof body.metadata === "object") {
      inlineMetadata = sanitizeClientMetadata(body.metadata);
    }
    if (body?.questionMeta && typeof body.questionMeta === "object") {
      inlineQuestionMeta = body.questionMeta;
    }
  } catch {
    /* No body / non-JSON → fall back to DB-stored answers. */
  }

  // Fetch submission
  const { data: submission, error: subError } = await db
    .from("submissions")
    .select(
      "id, test_id, student_id, answers, status, started_at, attempt_number, session_id, module_id, adaptive_track, metadata, percentage",
    )
    .eq("id", id)
    .eq("student_id", user.userId)
    .maybeSingle();

  // Read failure → 500 (the client retries); no row → the exam was deleted.
  if (subError) {
    console.error("[student/submissions/submit] read", subError);
    return NextResponse.json({ error: "Failed to load submission" }, { status: 500 });
  }
  if (!submission) {
    return NextResponse.json({ error: "Submission not found", code: "submission_gone" }, { status: 404 });
  }

  // Fetch test. We pull adaptive routing fields too — they're only used
  // when this submission is the Module 1 of an adaptive attempt, but
  // pulling them here keeps the query count down.
  const { data: test, error: testError } = await db
    .from("tests")
    .select(
      `id, module_id, time_limit_minutes, time_limit_minutes_module_2, is_untimed, question_ids, ${RECOVERY_TEST_COLUMNS}`,
    )
    .eq("id", submission.test_id)
    .single();

  if (testError || !test) {
    // Permanent: the client must not keep retrying this.
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }

  const device = deviceInfoFromHeaders(req.headers);

  // Module 1 → Module 2 handoff, retried once (a transient DB error must
  // not strand a student whose Module 1 is already graded).
  async function handoff(module1Percentage: number): Promise<string | null> {
    if (submission!.adaptive_track !== "module_1" || !submission!.session_id) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const next = await ensureModule2(
          db,
          {
            test_id: submission!.test_id,
            student_id: submission!.student_id,
            session_id: submission!.session_id,
            attempt_number: submission!.attempt_number,
            adaptive_track: submission!.adaptive_track,
            metadata: submission!.metadata,
          },
          test!,
          { module1Percentage, device },
        );
        return next?.id ?? null;
      } catch (e) {
        console.error(`[submit/module2_handoff] attempt ${attempt + 1}`, e);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error("module 2 handoff failed");
  }

  // Already graded (cron closed Module 1, or an earlier request of ours
  // landed but its response was lost): still 400, but tell the client
  // where to go next instead of leaving it on a dead end. An existing
  // Module 2 of this session is always handed back; a missing one is only
  // created through the recovery rules (this must be the student's latest
  // session, test Published, due-date window) — a stale request for an
  // old attempt must never add a Module 2 to it.
  async function alreadySubmitted() {
    let nextSubmissionId: string | null = null;
    let handoffFailed = false;
    const sub = submission!;
    if (sub.adaptive_track === "module_1" && sub.session_id) {
      try {
        const m1 = {
          test_id: sub.test_id,
          student_id: sub.student_id,
          session_id: sub.session_id,
          attempt_number: sub.attempt_number,
          adaptive_track: sub.adaptive_track,
        };
        nextSubmissionId = await findModule2(db, m1);
        if (!nextSubmissionId) {
          // recoverModule2 also requires Module 1 really graded (a winner
          // whose grading failed puts it back to In Progress).
          const recovered = await recoverModule2(db, sub.test_id, sub.student_id, test!, {
            device,
            onlySessionId: sub.session_id,
          });
          if (recovered && "id" in recovered) nextSubmissionId = recovered.id;
        }
      } catch (e) {
        console.error("[submit/already_submitted_handoff]", e);
        handoffFailed = true;
      }
    }
    return NextResponse.json(
      { error: "Submission already submitted", alreadySubmitted: true, nextSubmissionId, handoffFailed },
      { status: 400 },
    );
  }

  if (submission.status !== "In Progress") {
    return alreadySubmitted();
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
        module_2_id: (test.module_2_id as string | null) ?? null,
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
      extraUpdates:
        inlineMetadata || inlineQuestionMeta
          ? {
              metadata: {
                ...((submissionMetadata ?? {}) as Record<string, unknown>),
                ...(inlineMetadata ?? {}),
                ...(inlineQuestionMeta
                  ? applyQuestionMeta((submissionMetadata ?? {}) as Record<string, unknown>, inlineQuestionMeta)
                  : {}),
              },
            }
          : undefined,
      db,
    });
  } catch (e) {
    console.error("[submit/finalize]", e);
    // A module with no grading module is a configuration problem a retry
    // can't fix; everything else (DB hiccup) is worth retrying.
    if (e instanceof Error && /no grading module/.test(e.message)) {
      return NextResponse.json({ error: "Test is misconfigured — contact your teacher" }, { status: 422 });
    }
    return NextResponse.json({ error: "Failed to finalize submission" }, { status: 500 });
  }
  // Lost the claim: an overlapping submit (client retry, timer expiry +
  // manual click, cron) already finalized it. Same 400 as a late duplicate.
  if (!graded) {
    return alreadySubmitted();
  }
  const { status: finalStatus, correctCount, totalQuestions, percentage, timeSpentSeconds } = graded;

  // Module 1 → Module 2 handoff (adaptive: easy/hard by score; fixed:
  // module_2_id). Module 1 is already graded, so a failure is reported
  // (handoffFailed) rather than turned into an error — the take page
  // retries the handoff when the client goes there.
  let nextSubmissionId: string | null = null;
  let handoffFailed = false;
  try {
    nextSubmissionId = await handoff(percentage);
  } catch {
    handoffFailed = true;
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
      handoffFailed,
    },
  });
}
