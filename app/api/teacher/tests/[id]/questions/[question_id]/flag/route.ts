import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/teacher/tests/[id]/questions/[question_id]/flag
// Body: { note_type: "class_review" | "private_note", note_body: string }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; question_id: string }> }
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const { id: testId, question_id: questionId } = await params;
  const db = getServiceClient();

  // Verify access
  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (
    user.role !== "admin" &&
    !(assignment.teacher_ids as string[]).includes(user.userId)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const noteType = body.note_type as string;
  const noteBody = String(body.note_body ?? "");

  if (!["class_review", "private_note", "observation"].includes(noteType)) {
    return NextResponse.json({ error: "Invalid note_type" }, { status: 400 });
  }

  const { error } = await db.from("test_teacher_notes").upsert(
    {
      test_id: testId,
      teacher_id: user.userId,
      question_id: questionId,
      note_type: noteType,
      note_body: noteBody,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "test_id,teacher_id,question_id,note_type" }
  );

  if (error) {
    console.error("[flag/post]", error);
    return NextResponse.json({ error: "Failed to save note" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
