import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestAccess } from "@/lib/teacher-access";

// POST /api/teacher/tests/[id]/answer-visibility
// Body: { showAnswers?: boolean; showExplanations?: boolean }
//
// Live toggle for what students see on their own results page after
// submitting — separate from the class-review unlock. Lets a teacher/admin
// flip answer + explanation visibility on an ALREADY-created test without
// rebuilding it. Admins can toggle any test; teachers only tests they have
// access to.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId } = await params;
  let body: { showAnswers?: boolean; showExplanations?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.showAnswers !== "boolean" && typeof body.showExplanations !== "boolean") {
    return NextResponse.json(
      { error: "showAnswers or showExplanations is required" },
      { status: 400 },
    );
  }

  const db = getServiceClient();
  const access = await getTeacherTestAccess(db, user, testId);
  if (access.mode === null) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.showAnswers === "boolean") update.show_answers_after_submission = body.showAnswers;
  if (typeof body.showExplanations === "boolean") update.show_explanations_after_submission = body.showExplanations;

  const { error } = await db.from("tests").update(update).eq("id", testId);
  if (error) {
    console.error("[teacher/tests/answer-visibility]", error);
    return NextResponse.json(
      { error: `Failed to update: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    showAnswers: body.showAnswers,
    showExplanations: body.showExplanations,
  });
}
