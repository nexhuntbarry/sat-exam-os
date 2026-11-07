import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { roleError } from "../../../_shared";

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

  const crossSide = await forbidCrossSide(authResult, { testIds: [testId], userIds: incoming });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  const roleErr = await roleError(db, incoming, "student");
  if (roleErr) return NextResponse.json({ error: roleErr }, { status: 400 });

  // CAS loop: read current student_ids, merge, write only if unchanged.
  // Retries handle concurrent callers (e.g. two admins adding different students
  // at the same time) without either silently losing the other's additions.
  let added = 0;
  let mergedTotal = incoming.length; // fallback: at minimum all incoming were added
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error: readErr } = await db
      .from("test_assignments")
      .select("student_ids")
      .eq("test_id", testId)
      .maybeSingle();
    if (readErr) {
      console.error("[add-students] read error:", readErr);
      return NextResponse.json({ error: "Failed to add students" }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json({ error: "Test assignment not found" }, { status: 404 });
    }
    const existing: string[] = Array.isArray(row.student_ids) ? (row.student_ids as string[]) : [];
    const merged = Array.from(new Set([...existing, ...incoming]));
    mergedTotal = merged.length;
    added = merged.length - existing.length;
    if (added === 0) break; // all already present, nothing to do

    const { data: updated, error: writeErr } = await db
      .from("test_assignments")
      .update({ student_ids: merged })
      .eq("test_id", testId)
      .filter("student_ids", "eq", JSON.stringify(existing))
      .select("student_ids");
    if (writeErr) {
      console.error("[add-students] update error:", writeErr);
      return NextResponse.json({ error: "Failed to add students" }, { status: 500 });
    }
    if ((updated ?? []).length > 0) break; // CAS succeeded
    if (attempt < 4) await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    else return NextResponse.json({ error: "Concurrent update conflict — please retry" }, { status: 409 });
  }

  return NextResponse.json({ ok: true, added, total: mergedTotal });
}
