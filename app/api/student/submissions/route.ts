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
    .select("id, status, allow_retake, due_date, time_limit_minutes")
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

  // Check for existing submission
  const { data: existing } = await db
    .from("submissions")
    .select("id, status, attempt_number")
    .eq("test_id", body.testId)
    .eq("student_id", user.userId)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Look up an unconsumed retake grant up front so we can both honour
  // it as an override AND consume it after the new attempt is created.
  let grantId: string | null = null;
  if (existing && existing.status !== "In Progress") {
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
  }

  if (existing) {
    if (existing.status === "In Progress") {
      // Resume existing
      return NextResponse.json({ data: { id: existing.id, resumed: true } });
    }
    if (!test.allow_retake && !grantId) {
      return NextResponse.json({ error: "Retake not allowed" }, { status: 403 });
    }
  }

  const attemptNumber = existing ? (existing.attempt_number + 1) : 1;

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
