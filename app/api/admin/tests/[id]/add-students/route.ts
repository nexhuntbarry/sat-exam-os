import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/tests/[id]/add-students
// Body: { studentIds: string[] }
//
// Appends the supplied student ids to the test's existing
// `test_assignments.student_ids` array, preserving everyone already
// invited. Idempotent — duplicates are filtered.
//
// Returns the merged list and a count of newly added students so the
// UI can show a "Added N students" toast.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id: testId } = await params;
  let body: { studentIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const incoming = Array.isArray(body.studentIds)
    ? body.studentIds.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  if (incoming.length === 0) {
    return NextResponse.json({ error: "studentIds is required" }, { status: 400 });
  }

  const db = getServiceClient();
  const { data: assignment } = await db
    .from("test_assignments")
    .select("id, student_ids")
    .eq("test_id", testId)
    .single();

  if (!assignment) {
    return NextResponse.json({ error: "Test assignment not found" }, { status: 404 });
  }

  const existing: string[] = (assignment.student_ids as string[]) ?? [];
  const merged = Array.from(new Set([...existing, ...incoming]));
  const added = merged.length - existing.length;

  const { error } = await db
    .from("test_assignments")
    .update({ student_ids: merged })
    .eq("id", assignment.id);

  if (error) {
    console.error("[add-students] update error:", error);
    return NextResponse.json(
      { error: "Failed to add students" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, added, total: merged.length });
}
