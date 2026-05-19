import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { getTeacherTestAccess } from "@/lib/teacher-access";

// POST /api/teacher/tests/[id]/grant-retake
// Body: { studentId: string, notes?: string }
//
// Either the directly-assigned teacher OR the student's class teacher
// can grant a retake. Class teacher path additionally requires the
// target student to be in their class roster — prevents granting
// retakes to students they don't actually teach.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const grantor = authResult;

  const { id: testId } = await params;

  const db = getServiceClient();

  const access = await getTeacherTestAccess(db, grantor, testId);
  if (access.mode === null) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { studentId?: string; notes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.studentId) {
    return NextResponse.json({ error: "studentId is required" }, { status: 400 });
  }
  // Class teacher cannot grant retakes to students outside their class.
  if (access.mode === "class" && !access.studentAllowlist?.has(body.studentId)) {
    return NextResponse.json(
      { error: "Forbidden: student is not in your class" },
      { status: 403 },
    );
  }

  const { data: existing } = await db
    .from("test_retake_grants")
    .select("id")
    .eq("test_id", testId)
    .eq("student_id", body.studentId)
    .is("consumed_at", null)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ ok: true, grantId: existing.id, alreadyPending: true });
  }

  const { data, error } = await db
    .from("test_retake_grants")
    .insert({
      test_id: testId,
      student_id: body.studentId,
      granted_by: grantor.userId,
      notes: body.notes ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[teacher/grant-retake]", error);
    return NextResponse.json({ error: "Failed to grant retake" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, grantId: data.id });
}
