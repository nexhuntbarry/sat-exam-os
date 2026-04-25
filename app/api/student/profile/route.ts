import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";

// GET /api/student/profile
export async function GET() {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  const db = getServiceClient();
  const { data, error } = await db
    .from("student_profiles")
    .select("grade, school, target_score, class_group")
    .eq("user_id", user.userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Failed to load profile" }, { status: 500 });
  }

  return NextResponse.json(data ?? {});
}

// PATCH /api/student/profile
export async function PATCH(req: Request) {
  const authResult = await requireRole("student");
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult;

  let body: { grade?: string; school?: string; target_score?: number | null; class_group?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const db = getServiceClient();

  const { error } = await db
    .from("student_profiles")
    .upsert(
      {
        user_id: user.userId,
        grade: body.grade ?? null,
        school: body.school ?? null,
        target_score: body.target_score ?? null,
        class_group: body.class_group ?? null,
      },
      { onConflict: "user_id" }
    );

  if (error) {
    console.error("[student/profile/patch]", error);
    return NextResponse.json({ error: "Failed to save profile" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
