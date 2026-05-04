import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/teacher/tests/[id]/grant-retake
// Body: { studentId: string, notes?: string }
//
// Same as the admin variant but gated by teacher_ids includes user
// (admins bypass) — lets the assigned teacher unlock a retake without
// admin ping-pong.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole(["teacher", "admin"]);
  if (authResult instanceof NextResponse) return authResult;
  const grantor = authResult;

  const { id: testId } = await params;

  const db = getServiceClient();

  const { data: assignment } = await db
    .from("test_assignments")
    .select("teacher_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) {
    return NextResponse.json({ error: "Test not found" }, { status: 404 });
  }
  if (
    grantor.role !== "admin" &&
    !(assignment.teacher_ids as string[]).includes(grantor.userId)
  ) {
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
