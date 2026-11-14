import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { parentOf } from "@/lib/full-length";
import { writeTeacherQaEnabled } from "@/lib/teacher-qa";

// POST /api/admin/tests/[id]/teacher-qa   Body: { enabled: boolean }
// Admin only. The per-test switch "Teachers can view & print
// questions/answers" (lib/teacher-qa). A full-length SAT is set on the
// parent, which governs both sections. 503 until migration 0032 is applied.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;

  let body: { enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled (boolean) is required" }, { status: 400 });
  }

  const db = getServiceClient();
  try {
    const { data: row, error } = await db.from("tests").select("id").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return NextResponse.json({ error: "Test not found" }, { status: 404 });
    if ((await parentOf(db, [id])).size > 0) {
      return NextResponse.json(
        { error: "This is a section of a full-length SAT — set this on the full-length test instead." },
        { status: 409 },
      );
    }
    if ((await writeTeacherQaEnabled(db, id, body.enabled)) === "column-missing") {
      return NextResponse.json(
        { error: "Database update pending: run migration 0032_teacher_qa_enabled first.", code: "db_update_pending" },
        { status: 503 },
      );
    }
  } catch (e) {
    console.error("[admin/tests/teacher-qa]", e);
    return NextResponse.json({ error: "Failed to update the setting" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, enabled: body.enabled });
}
