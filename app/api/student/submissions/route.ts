import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { deviceInfoFromHeaders } from "@/lib/student-exam";
import { recoverModule2 } from "@/lib/module2-handoff";
import { studentTestAccess } from "@/lib/module2-access";
import { dropUnansweredSubmission, testIsDraftNow } from "@/lib/draft-race";
import { loadTimeMultiplier } from "@/lib/full-length-admin";
import { concurrentStartId, startPlan, studentStartRows } from "@/lib/start-race";

export const maxDuration = 60;

// POST /api/student/submissions — start a test (create submission)
export async function POST(req: Request) {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  let body: { testId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.testId) {
    return NextResponse.json({ error: "testId is required" }, { status: 400 });
  }

  const db = getServiceClient();

  // Verify test is published. Needs migration 0031 (test_kind,
  // parent_test_id) applied BEFORE this code is deployed.
  const { data: test, error: testError } = await db
    .from("tests")
    .select(
      "id, status, allow_retake, open_date, due_date, time_limit_minutes, module_id, module_2_id, is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, adaptive_threshold, test_kind, parent_test_id",
    )
    .eq("id", body.testId)
    .single();

  if (testError || !test) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }

  // Full-length SAT: a section child is never started on its own, and the
  // parent has its own start flow — neither goes through this route.
  if (test.parent_test_id || test.test_kind === "full_length") {
    return NextResponse.json(
      { error: "This is part of a full-length SAT — start it from the full-length test page." },
      { status: 409 },
    );
  }

  // Same QA side, Published, assigned (shared with the take page). A
  // student un-assigned mid-attempt may still finish it, not start anew.
  const access = await studentTestAccess(db, user, test);
  if (access.error) return NextResponse.json({ error: access.error.error }, { status: access.error.status });

  const device = deviceInfoFromHeaders(req.headers);

  // Handoff recovery (prevents the "Module 2 crashed and the test reset"
  // bug). For a two-module / adaptive test, if the student's most recent
  // session has Module 1 submitted but no Module 2 row — because the
  // Module 1→2 handoff failed, or they crashed before Module 2 was created
  // — "start" would otherwise create a brand-new attempt from Module 1,
  // i.e. appear to reset. Instead, recreate the Module 2 submission for
  // that session and resume it. Runs before the due-date check: after the
  // due date it is still allowed within 24 h of Module 1 being graded
  // (lib/module2-handoff module2RecoveryBlock), then the attempt is closed.
  try {
    const recovered = await recoverModule2(db, body.testId, user.userId, test, { device });
    if (recovered && "blocked" in recovered) {
      return NextResponse.json(
        {
          error:
            "This attempt is closed — Module 2 can't be started after the due date. Ask your teacher if you need to finish it.",
          blocked: recovered.blocked,
        },
        { status: 403 },
      );
    }
    if (recovered) {
      return NextResponse.json({ data: { id: recovered.id, resumed: true, recovered: true } });
    }
  } catch (e) {
    console.error("[student/submissions] M2 recovery failed:", e);
    return NextResponse.json(
      { error: "Couldn't open Module 2 — please try again." },
      { status: 503 },
    );
  }

  if (test.open_date && new Date(test.open_date) > new Date()) {
    return NextResponse.json({ error: "Test is not open yet" }, { status: 403 });
  }

  if (test.due_date && new Date(test.due_date) < new Date()) {
    return NextResponse.json({ error: "Test due date has passed" }, { status: 403 });
  }

  // Adaptive tests need Module 1 + at least one Module 2 track wired up
  // before any student can start. We refuse here rather than at create
  // time so admins can save a draft and pick modules later.
  if (test.is_adaptive) {
    if (!test.module_1_id) {
      return NextResponse.json(
        { error: "Adaptive test is missing Module 1" },
        { status: 400 },
      );
    }
    if (!test.module_2_easy_id && !test.module_2_hard_id) {
      return NextResponse.json(
        { error: "Adaptive test needs at least one Module 2 track" },
        { status: 400 },
      );
    }
  }

  // Resume any in-progress row first — for an adaptive test that's
  // either Module 1 (still being taken) or Module 2 (Module 1 already
  // graded and the route picker handed off). The same read gives the
  // highest prior attempt, so a concurrent Start's brand-new row is
  // resumed, never counted as a finished attempt (lib/start-race).
  let plan: ReturnType<typeof startPlan>;
  try {
    plan = startPlan(await studentStartRows(db, body.testId, user.userId));
  } catch (e) {
    console.error("[student/submissions/post]", e);
    return NextResponse.json({ error: "Couldn't start the test — please try again." }, { status: 503 });
  }

  if ("resumeId" in plan) {
    return NextResponse.json({ data: { id: plan.resumeId, resumed: true } });
  }

  if (!access.assigned) {
    return NextResponse.json({ error: "Test is not assigned to you" }, { status: 403 });
  }

  // No in-progress row → the highest prior attempt gates retake. For
  // adaptive attempts both Module 1 and Module 2 share an attempt_number,
  // so max(attempt_number) is the right "prior count".
  const priorMax = plan.priorMax;

  let grantId: string | null = null;
  if (priorMax !== null) {
    const { data: grant } = await db
      .from("test_retake_grants")
      .select("id")
      .eq("test_id", body.testId)
      .eq("student_id", user.userId)
      .is("consumed_at", null)
      .order("granted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    grantId = grant?.id ?? null;

    if (!test.allow_retake && !grantId) {
      // A concurrent Start may have just created the attempt and used the
      // grant (it consumes only after its insert): resume that one.
      const raced = await concurrentStartId(db, body.testId, user.userId).catch(() => null);
      if (raced) return NextResponse.json({ data: { id: raced, resumed: true } });
      return NextResponse.json({ error: "Retake not allowed" }, { status: 403 });
    }
  }

  const attemptNumber = priorMax !== null ? priorMax + 1 : 1;

  // Three start paths:
  //  1. Adaptive: session_id, Module 1 first, route picker on submit.
  //  2. Non-adaptive 2-module: session_id, Module 1 first, fixed
  //     handoff to module_2_id on submit (no easy/hard decision).
  //  3. Legacy single-module: no session, plain submission.
  const isAdaptive = !!test.is_adaptive;
  const isTwoModuleNonAdaptive = !isAdaptive && !!test.module_2_id;
  const sessionId =
    isAdaptive || isTwoModuleNonAdaptive ? globalThis.crypto.randomUUID() : null;
  const moduleId = isAdaptive ? test.module_1_id : test.module_id;
  const adaptiveTrack =
    isAdaptive || isTwoModuleNonAdaptive ? "module_1" : null;

  // Extended time (test_time_accommodations, else the student's profile
  // testing time in users.metadata), snapshotted onto the attempt:
  // Module 2 inherits it at the handoff, and a later change only affects
  // attempts started afterwards. Server-owned; the client can't set it.
  let timeMultiplier: number;
  try {
    timeMultiplier = await loadTimeMultiplier(db, body.testId, user.userId);
  } catch (e) {
    console.error("[student/submissions/post]", e);
    return NextResponse.json({ error: "Couldn't start the test — please try again." }, { status: 503 });
  }

  const { data: submission, error: subError } = await db
    .from("submissions")
    .insert({
      test_id: body.testId,
      student_id: user.userId,
      answers: {},
      status: "In Progress",
      started_at: new Date().toISOString(),
      attempt_number: attemptNumber,
      metadata: {
        ...(device ? { device } : {}),
        ...(timeMultiplier !== 1 ? { time_multiplier: timeMultiplier } : {}),
      },
      session_id: sessionId,
      module_id: moduleId,
      adaptive_track: adaptiveTrack,
    })
    .select("id")
    .single();

  if (subError?.code === "23505") {
    // A concurrent Start read the same rows and inserted this attempt
    // number first (uniq_submissions_attempt_legacy / _adaptive): resume it.
    const raced = await concurrentStartId(db, body.testId, user.userId).catch(() => null);
    if (raced) return NextResponse.json({ data: { id: raced, resumed: true } });
    // The winner's row is gone already (it hit the Draft race below).
    if (await testIsDraftNow(db, body.testId)) {
      return NextResponse.json({ error: "Test is not available" }, { status: 403 });
    }
    return NextResponse.json({ error: "Couldn't start the test — please try again." }, { status: 503 });
  }

  if (subError || !submission) {
    console.error("[student/submissions/post]", subError);
    return NextResponse.json({ error: "Failed to create submission" }, { status: 500 });
  }

  // The test went back to Draft while we were starting (lib/draft-race).
  if (await testIsDraftNow(db, body.testId)) {
    await dropUnansweredSubmission(db, submission.id);
    return NextResponse.json({ error: "Test is not available" }, { status: 403 });
  }

  // Mark the grant consumed once the new attempt is safely on disk so a
  // network blip during create doesn't burn the grant.
  // Only the request whose insert won gets here, so the grant is used once.
  if (grantId) {
    const { error: grantUseError } = await db
      .from("test_retake_grants")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", grantId)
      .is("consumed_at", null);
    if (grantUseError) console.error("[student/submissions/post] consume grant", grantId, grantUseError.message);
  }

  return NextResponse.json({ data: { id: submission.id, resumed: false } }, { status: 201 });
}
