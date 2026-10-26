import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";

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

  // A non-admin may only target a class they teach (class_group_teachers),
  // in a subject they teach there.
  let cohortSubject: string | null = null;
  let teacherSubjects: (string | null)[] = [];
  if (teacher.role !== "admin") {
    const { data: myGroups, error: groupError } = await db
      .from("class_group_teachers")
      .select("class_group_id, subject")
      .eq("teacher_id", teacher.userId);
    if (groupError) {
      console.error("[teaching-mode/quick-test] class groups", groupError);
      return NextResponse.json({ error: "Failed to verify class" }, { status: 500 });
    }
    teacherSubjects = (myGroups ?? []).map((g) => (g.subject as string | null) ?? null);
    if (cohortId) {
      const mine = (myGroups ?? []).find((g) => g.class_group_id === cohortId);
      if (!mine) {
        return NextResponse.json({ error: "You can only assign tests to classes you teach" }, { status: 403 });
      }
      cohortSubject = (mine.subject as string | null) ?? null;
    }
  }

  // Verify questions exist and pull a module_id (tests require a module_id)
  const { data: qrows } = await db
    .from("questions")
    .select("id, module_id, modules!inner(section)")
    .in("id", questionIds);

  if (!qrows || qrows.length === 0) {
    return NextResponse.json({ error: "no valid questions" }, { status: 400 });
  }

  // One subject per test: the test is scored and analysed under its
  // module's section, so mixing Math and R&W questions would misfile them.
  const sections = new Set(
    qrows.map((q) => (q.modules as unknown as { section: string } | null)?.section ?? null),
  );
  if (sections.size > 1) {
    return NextResponse.json(
      { error: "All questions must be from the same subject (Math or Reading & Writing)" },
      { status: 400 },
    );
  }
  const section = Array.from(sections)[0];
  const allowed = cohortId ? [cohortSubject] : teacherSubjects;
  if (teacher.role !== "admin" && allowed.length > 0 && section && !allowed.some((s) => !s || s === section)) {
    return NextResponse.json(
      { error: `You don't teach ${section} for this class` },
      { status: 403 },
    );
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
  const crossSide = await forbidCrossSide(teacher, { classGroupIds, userIds: studentIds });
  if (crossSide) return crossSide;

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
    .select("id, created_at")
    .single();

  if (testError || !test) {
    console.error("[teaching-mode/quick-test] insert test", testError);
    return NextResponse.json({ error: "Failed to create test" }, { status: 500 });
  }

  // Duplicate guard (network retry / double POST): if this teacher created
  // a same-named test in the last 30s, the earliest one wins and the later
  // insert is rolled back. Running the check after the insert means two
  // concurrent requests both see both rows and agree on the same winner.
  const since = new Date(new Date(test.created_at as string).getTime() - 30_000).toISOString();
  const { data: twins } = await db
    .from("tests")
    .select("id, created_at")
    .eq("created_by", teacher.userId)
    .eq("test_name", name)
    .eq("status", "Draft")
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  const winner = twins?.[0];
  if (winner && winner.id !== test.id) {
    await db.from("tests").delete().eq("id", test.id);
    return NextResponse.json(
      { data: { id: winner.id, studentCount: studentIds.length, duplicate: true } },
      { status: 200 },
    );
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
