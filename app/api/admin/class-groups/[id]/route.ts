import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// PATCH /api/admin/class-groups/[id]
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  let body: { name?: string; campus?: string; grade?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, string> = {};
  if (body.name) patch.name = body.name;
  if (body.campus !== undefined) patch.campus = body.campus;
  if (body.grade !== undefined) patch.grade = body.grade;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const db = getServiceClient();
  const { error } = await db.from("class_groups").update(patch).eq("id", id);

  if (error) {
    console.error("[class-groups/patch] DB error:", error);
    return NextResponse.json({ error: "Failed to update class group" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// DELETE /api/admin/class-groups/[id]
//
// Permanently removes a class group. ON DELETE CASCADE on
// class_group_members and class_group_teachers takes care of cleanup.
// Tests that referenced this class via test_assignments.class_group_ids
// keep the array reference but the class id will simply be orphan — the
// admin should already be aware before invoking this.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const db = getServiceClient();

  // Surface a friendly count so the UI can warn precisely.
  const [{ count: memberCount }, { count: teacherCount }] = await Promise.all([
    db
      .from("class_group_members")
      .select("id", { count: "exact", head: true })
      .eq("class_group_id", id),
    db
      .from("class_group_teachers")
      .select("id", { count: "exact", head: true })
      .eq("class_group_id", id),
  ]);

  const { error } = await db.from("class_groups").delete().eq("id", id);
  if (error) {
    console.error("[class-groups/delete] DB error:", error);
    return NextResponse.json(
      { error: "Failed to delete class group" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    removedMembers: memberCount ?? 0,
    removedTeacherAssignments: teacherCount ?? 0,
  });
}
