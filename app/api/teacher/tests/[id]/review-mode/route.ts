import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestAccess } from "@/lib/teacher-access";

// POST /api/teacher/tests/[id]/review-mode
// Body: { unlocked: boolean }
//
// Flips tests.review_unlocked. Admins can toggle any test; teachers
// only ones they're assigned to. We don't gate on test status — a
// closed test can still have its answers walked through in class.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId } = await params;
  let body: { unlocked?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.unlocked !== "boolean") {
    return NextResponse.json({ error: "unlocked is required" }, { status: 400 });
  }

  const db = getServiceClient();

  // Class teachers can flip review mode for tests their students took
  // — review walkthrough is a class-time activity, not a test-owner
  // privilege.
  const access = await getTeacherTestAccess(db, user, testId);
  if (access.mode === null) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error } = await db
    .from("tests")
    .update({ review_unlocked: body.unlocked, updated_at: new Date().toISOString() })
    .eq("id", testId);

  if (error) {
    console.error("[teacher/tests/review-mode]", error);
    return NextResponse.json(
      { error: `Failed to toggle review mode: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, unlocked: body.unlocked });
}
