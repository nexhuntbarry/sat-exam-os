import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

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

  // Verify test is published
  const { data: test, error: testError } = await db
    .from("tests")
    .select(
      "id, status, allow_retake, due_date, time_limit_minutes, module_id, module_2_id, is_adaptive, module_1_id, module_2_easy_id, module_2_hard_id, adaptive_threshold",
    )
    .eq("id", body.testId)
    .single();

  if (testError || !test) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }

  if (test.status !== "Published") {
    return NextResponse.json({ error: "Test is not available" }, { status: 403 });
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
  // graded and the route picker handed off).
  const { data: inProgress } = await db
    .from("submissions")
    .select("id")
    .eq("test_id", body.testId)
    .eq("student_id", user.userId)
    .eq("status", "In Progress")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (inProgress) {
    return NextResponse.json({ data: { id: inProgress.id, resumed: true } });
  }

  // No in-progress row → look at the highest prior attempt to gate
  // retake. For adaptive attempts both Module 1 and Module 2 share an
  // attempt_number, so max(attempt_number) is the right "prior count".
  const { data: priorMax } = await db
    .from("submissions")
    .select("attempt_number")
    .eq("test_id", body.testId)
    .eq("student_id", user.userId)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  let grantId: string | null = null;
  if (priorMax) {
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
      return NextResponse.json({ error: "Retake not allowed" }, { status: 403 });
    }
  }

  const attemptNumber = priorMax ? priorMax.attempt_number + 1 : 1;

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

  const { data: submission, error: subError } = await db
    .from("submissions")
    .insert({
      test_id: body.testId,
      student_id: user.userId,
      answers: {},
      status: "In Progress",
      started_at: new Date().toISOString(),
      attempt_number: attemptNumber,
      metadata: {},
      session_id: sessionId,
      module_id: moduleId,
      adaptive_track: adaptiveTrack,
    })
    .select("id")
    .single();

  if (subError || !submission) {
    console.error("[student/submissions/post]", subError);
    return NextResponse.json({ error: "Failed to create submission" }, { status: 500 });
  }

  // Mark the grant consumed once the new attempt is safely on disk so a
  // network blip during create doesn't burn the grant.
  if (grantId) {
    await db
      .from("test_retake_grants")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", grantId);
  }

  return NextResponse.json({ data: { id: submission.id, resumed: false } }, { status: 201 });
}
