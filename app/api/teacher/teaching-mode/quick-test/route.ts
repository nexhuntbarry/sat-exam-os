import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/teacher/teaching-mode/quick-test
// Body: { name: string, questionIds: string[], cohortId?: string }
// Creates a Draft test seeded with the chosen questions and (when a cohort
// is provided) auto-assigns it to that class group's students plus this
// teacher. Cohort here means a class_groups row id; if omitted we still
// create the test in Draft so the teacher can publish it manually later.
export async function POST(req: Request) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const teacher = authResult;

  let body: { name?: string; questionIds?: string[]; cohortId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  const questionIds = body.questionIds ?? [];
  const cohortId = body.cohortId?.trim() || null;

  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (questionIds.length === 0) {
    return NextResponse.json({ error: "questionIds must be non-empty" }, { status: 400 });
  }

  const db = getServiceClient();

  // Verify questions exist and pull a module_id (tests require a module_id)
  const { data: qrows } = await db
    .from("questions")
    .select("id, module_id")
    .in("id", questionIds);

  if (!qrows || qrows.length === 0) {
    return NextResponse.json({ error: "no valid questions" }, { status: 400 });
  }

  // Use the first question's module_id (tests reference a single module)
  const moduleId = qrows[0].module_id;
  const validQuestionIds = qrows.map((q) => q.id);

  // Resolve cohort -> student_ids
  let studentIds: string[] = [];
  let classGroupIds: string[] = [];
  if (cohortId) {
    classGroupIds = [cohortId];
    const { data: members } = await db
      .from("class_group_members")
      .select("student_id")
      .eq("class_group_id", cohortId);
    studentIds = (members ?? []).map((m) => m.student_id);
  }

  // Create the test (Draft so the teacher can review before publishing)
  const { data: test, error: testError } = await db
    .from("tests")
    .insert({
      test_name: name,
      module_id: moduleId,
      question_ids: validQuestionIds,
      status: "Draft",
      created_by: teacher.userId,
    })
    .select("id")
    .single();

  if (testError || !test) {
    console.error("[teaching-mode/quick-test] insert test", testError);
    return NextResponse.json({ error: "Failed to create test" }, { status: 500 });
  }

  const { error: assignError } = await db.from("test_assignments").insert({
    test_id: test.id,
    teacher_ids: [teacher.userId],
    student_ids: studentIds,
    class_group_ids: classGroupIds,
    created_by: teacher.userId,
  });

  if (assignError) {
    console.error("[teaching-mode/quick-test] insert assignment", assignError);
  }

  return NextResponse.json({ data: { id: test.id, studentCount: studentIds.length } }, { status: 201 });
}
