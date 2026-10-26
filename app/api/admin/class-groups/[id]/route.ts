import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { classNameTaken } from "../../_shared";

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

  const patch: Record<string, string | null> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    patch.name = name;
  }
  if (body.campus !== undefined) patch.campus = body.campus?.trim() || null;
  if (body.grade !== undefined) patch.grade = body.grade?.trim() || null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const crossSide = await forbidCrossSide(authResult, { classGroupIds: [id] });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  if (patch.name && (await classNameTaken(db, patch.name, authResult.isQa, id))) {
    return NextResponse.json({ error: "A class with this name already exists" }, { status: 409 });
  }
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
// test_assignments.class_group_ids is a plain uuid[] (no FK), so the id is
// stripped from every test that referenced it here; otherwise the tests
// would keep an orphan id.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { classGroupIds: [id] });
  if (crossSide) return crossSide;

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

  const { data: linked, error: linkedError } = await db
    .from("test_assignments")
    .select("id, class_group_ids")
    .contains("class_group_ids", [id]);
  if (linkedError) {
    console.error("[class-groups/delete] assignment lookup error:", linkedError);
    return NextResponse.json({ error: "Failed to delete class group" }, { status: 500 });
  }
  for (const a of linked ?? []) {
    const { error: unlinkError } = await db
      .from("test_assignments")
      .update({ class_group_ids: ((a.class_group_ids as string[]) ?? []).filter((c) => c !== id) })
      .eq("id", a.id);
    if (unlinkError) {
      console.error("[class-groups/delete] unlink error:", unlinkError);
      return NextResponse.json({ error: "Failed to unlink class from tests" }, { status: 500 });
    }
  }

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
    unlinkedTests: (linked ?? []).length,
    removedMembers: memberCount ?? 0,
    removedTeacherAssignments: teacherCount ?? 0,
  });
}
