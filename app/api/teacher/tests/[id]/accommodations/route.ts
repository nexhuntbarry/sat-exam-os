import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestAccess } from "@/lib/teacher-access";
import { forbidCrossSide } from "@/lib/qa";
import {
  accommodationKind,
  FULL_LENGTH_DISABLED_MESSAGE,
  fullLengthEnabledFor,
  listAccommodations,
  multiplierError,
  setAccommodation,
  studentOnFullLengthTest,
} from "@/lib/full-length-admin";

// Per-student extended time on a full-length SAT test or a section test, for teachers.
// Access as for the test's results (getTeacherTestAccess): a class
// teacher only sees and sets their own class students. Changes apply to
// attempts started afterwards.

// GET /api/teacher/tests/[id]/accommodations
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;

  const db = getServiceClient();
  const access = await getTeacherTestAccess(db, authResult, id);
  if (access.mode === null) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await listAccommodations(db, id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  const allow = access.studentAllowlist;
  return NextResponse.json({ data: allow ? data.filter((a) => allow.has(a.student_id)) : data });
}

// PUT /api/teacher/tests/[id]/accommodations  { studentId, multiplier: 1.25 | 1.5 | 2 | null }
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;
  const { id } = await params;

  let body: { studentId?: unknown; multiplier?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
  if (typeof body.studentId !== "string" || !body.studentId) return bad("studentId is required");
  if (body.multiplier === undefined) return bad("multiplier is required (null clears it)");
  const multErr = multiplierError(body.multiplier);
  if (multErr) return bad(multErr);

  const db = getServiceClient();
  const access = await getTeacherTestAccess(db, user, id);
  if (access.mode === null) return bad("Forbidden", 403);
  const { data: test, error: testErr } = await db
    .from("tests")
    .select("test_kind, parent_test_id")
    .eq("id", id)
    .maybeSingle();
  if (testErr) return bad("Could not load the test", 500);
  if (!test) return bad("Test not found", 404);
  const kind = accommodationKind(test);
  if (!kind) return bad("Set extended time on the full-length SAT test, not on one of its sections", 400);
  // The full-length flag only gates full-length tests.
  if (kind === "full_length" && !(await fullLengthEnabledFor(db, user))) return bad(FULL_LENGTH_DISABLED_MESSAGE, 403);

  // A section test is one subject, which getTeacherTestAccess already
  // scoped; only a full-length test spans both.
  if (kind === "full_length" && user.role !== "admin") {
    // A teacher pinned to one subject only sees one section of the test,
    // so extended time (which covers both sections) isn't theirs to set.
    const { data: rows, error: rowsErr } = await db
      .from("class_group_teachers")
      .select("subject")
      .eq("teacher_id", user.userId);
    if (rowsErr) return bad("Could not check your classes", 500);
    // Allowed when the teacher's classes cover both sections: any
    // null-subject ("both") row, or Math rows and R&W rows. No class rows
    // = a direct reviewer (full access already checked above).
    const subjects = ((rows ?? []) as { subject: string | null }[]).map((r) => r.subject);
    const coversBoth =
      subjects.includes(null) || (subjects.includes("Math") && subjects.includes("Reading & Writing"));
    if (subjects.length > 0 && !coversBoth) {
      return bad("Teachers of a single subject can't set extended time. Ask an admin.", 403);
    }
  }
  if (access.studentAllowlist && !access.studentAllowlist.has(body.studentId)) {
    // Class teacher: own roster only.
    return bad("You can only set extended time for your own students", 403);
  }
  const crossSide = await forbidCrossSide(user, { userIds: [body.studentId] });
  if (crossSide) return crossSide;
  const { data: student } = await db.from("users").select("id").eq("id", body.studentId).eq("role", "student").maybeSingle();
  if (!student) return bad("Only students can be given extended time");
  // Clearing is always allowed (e.g. a student who left the class).
  if (body.multiplier !== null && !(await studentOnFullLengthTest(db, id, body.studentId))) {
    return bad("This student isn't assigned to this test and has no work on it");
  }

  const err = await setAccommodation(db, id, body.studentId, body.multiplier as number | null, user.userId);
  if (err) return bad(err, 500);
  return NextResponse.json({ success: true });
}
