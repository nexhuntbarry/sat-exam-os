import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestAccess } from "@/lib/teacher-access";

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

  // Class teachers can flag — notes are scoped per teacher_id so no
  // collision risk with other teachers on the same test.
  const access = await getTeacherTestAccess(db, user, testId);
  if (access.mode === null) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { note_type?: unknown; note_body?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const noteType = body.note_type as string;
  const noteBody = String(body.note_body ?? "");

  if (!["class_review", "private_note", "observation"].includes(noteType)) {
    return NextResponse.json({ error: "Invalid note_type" }, { status: 400 });
  }

  // The question must belong to this test (its question_ids, or one of its
  // modules) — otherwise an unknown id hits the FK and 500s, and another
  // test's question would be silently accepted.
  const [{ data: test }, { data: question }] = await Promise.all([
    db
      .from("tests")
      .select("question_ids, module_id, module_2_id, module_1_id, module_2_easy_id, module_2_hard_id")
      .eq("id", testId)
      .maybeSingle(),
    db.from("questions").select("id, module_id").eq("id", questionId).maybeSingle(),
  ]);
  const testQuestionIds = (test?.question_ids as string[] | null) ?? [];
  const testModuleIds = [
    test?.module_id,
    test?.module_2_id,
    test?.module_1_id,
    test?.module_2_easy_id,
    test?.module_2_hard_id,
  ].filter(Boolean);
  const inTest =
    !!question &&
    (testQuestionIds.includes(question.id as string) ||
      testModuleIds.includes(question.module_id));
  if (!inTest) {
    return NextResponse.json({ error: "Question is not part of this test" }, { status: 404 });
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
