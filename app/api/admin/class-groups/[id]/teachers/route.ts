import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/class-groups/[id]/teachers
// Body: { teacherIds: string[] }
// Adds the supplied teachers to this class. Idempotent — duplicates ignored.
//
// DELETE /api/admin/class-groups/[id]/teachers
// Body: { teacherIds: string[] }
// Removes the supplied teacher assignments. Returns the count removed.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const admin = authResult;

  const { id: classGroupId } = await params;
  let body: { teacherIds?: string[]; subject?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const incoming = Array.isArray(body.teacherIds)
    ? body.teacherIds.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  if (incoming.length === 0) {
    return NextResponse.json({ error: "teacherIds is required" }, { status: 400 });
  }
  const subject = normalizeSubject(body.subject);

  const db = getServiceClient();
  const rows = incoming.map((teacherId) => ({
    class_group_id: classGroupId,
    teacher_id: teacherId,
    assigned_by: admin.userId,
    subject,
  }));

  const { error } = await db
    .from("class_group_teachers")
    .upsert(rows, { onConflict: "class_group_id,teacher_id", ignoreDuplicates: true });

  if (error) {
    console.error("[class-groups/teachers POST]", error);
    return NextResponse.json({ error: "Failed to assign teachers" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, added: rows.length });
}

// PATCH /api/admin/class-groups/[id]/teachers
// Body: { teacherId: string; subject: "Math" | "Reading & Writing" | null }
// Sets the subject a teacher is scoped to for this class (null = both).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id: classGroupId } = await params;
  let body: { teacherId?: string; subject?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.teacherId) {
    return NextResponse.json({ error: "teacherId is required" }, { status: 400 });
  }
  const subject = normalizeSubject(body.subject);

  const db = getServiceClient();
  const { error } = await db
    .from("class_group_teachers")
    .update({ subject })
    .eq("class_group_id", classGroupId)
    .eq("teacher_id", body.teacherId);

  if (error) {
    console.error("[class-groups/teachers PATCH]", error);
    return NextResponse.json({ error: "Failed to update subject" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, subject });
}

// Accept only the two valid sections or null (both); anything else → null.
function normalizeSubject(s: string | null | undefined): string | null {
  return s === "Math" || s === "Reading & Writing" ? s : null;
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id: classGroupId } = await params;
  let body: { teacherIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.teacherIds)
    ? body.teacherIds.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "teacherIds is required" }, { status: 400 });
  }

  const db = getServiceClient();
  const { error, count } = await db
    .from("class_group_teachers")
    .delete({ count: "exact" })
    .eq("class_group_id", classGroupId)
    .in("teacher_id", ids);

  if (error) {
    console.error("[class-groups/teachers DELETE]", error);
    return NextResponse.json({ error: "Failed to remove" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, removed: count ?? 0 });
}
