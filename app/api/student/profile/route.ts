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

  // Trim + length-cap free-text fields to keep DB rows bounded and to
  // reject obviously bogus payloads (e.g. multi-MB blobs from a manual POST).
  const grade = typeof body.grade === "string" ? body.grade.trim().slice(0, 50) : null;
  const school = typeof body.school === "string" ? body.school.trim().slice(0, 200) : null;
  const classGroup = typeof body.class_group === "string" ? body.class_group.trim().slice(0, 100) : null;

  // SAT score range: 400-1600. Reject anything outside this band.
  let targetScore: number | null = null;
  if (body.target_score !== null && body.target_score !== undefined) {
    const n = Number(body.target_score);
    if (!Number.isFinite(n) || n < 400 || n > 1600) {
      return NextResponse.json(
        { error: "target_score must be between 400 and 1600" },
        { status: 400 }
      );
    }
    targetScore = Math.round(n);
  }

  const db = getServiceClient();

  const { error } = await db
    .from("student_profiles")
    .upsert(
      {
        user_id: user.userId,
        grade,
        school,
        target_score: targetScore,
        class_group: classGroup,
      },
      { onConflict: "user_id" }
    );

  if (error) {
    console.error("[student/profile/patch]", error);
    return NextResponse.json({ error: "Failed to save profile" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
