import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/tests/[id]/grant-retake
// Body: { studentId: string, notes?: string }
//
// Inserts an unconsumed grant so the student can start one new attempt
// on this test. Idempotent — if a pending grant already exists, returns
// it as-is rather than throwing on the partial unique index.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const grantor = authResult;

  const { id: testId } = await params;
  let body: { studentId?: string; notes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.studentId) {
    return NextResponse.json({ error: "studentId is required" }, { status: 400 });
  }

  const db = getServiceClient();

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
    console.error("[admin/grant-retake]", error);
    return NextResponse.json({ error: "Failed to grant retake" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, grantId: data.id });
}
