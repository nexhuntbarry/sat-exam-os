import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// POST /api/admin/class-groups/[id]/members — add or remove student
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id: classGroupId } = await params;
  let body: { studentId: string; action: "add" | "remove" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.studentId || !["add", "remove"].includes(body.action)) {
    return NextResponse.json(
      { error: "studentId and action (add|remove) are required" },
      { status: 400 }
    );
  }

  const db = getServiceClient();

  if (body.action === "add") {
    const { error } = await db.from("class_group_members").upsert(
      { class_group_id: classGroupId, student_id: body.studentId },
      { onConflict: "class_group_id,student_id" }
    );
    if (error) {
      console.error("[class-members/add] DB error:", error);
      return NextResponse.json({ error: "Failed to add member" }, { status: 500 });
    }
  } else {
    const { error } = await db
      .from("class_group_members")
      .delete()
      .eq("class_group_id", classGroupId)
      .eq("student_id", body.studentId);
    if (error) {
      console.error("[class-members/remove] DB error:", error);
      return NextResponse.json({ error: "Failed to remove member" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
