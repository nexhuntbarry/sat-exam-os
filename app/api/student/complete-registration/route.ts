import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.role !== "student") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: {
    fullName?: string;
    grade?: string;
    school?: string;
    parentName?: string;
    parentEmail?: string;
    parentPhone?: string;
    targetScore?: number;
    currentLevel?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { fullName, grade, school, parentName, parentEmail, parentPhone, targetScore, currentLevel } = body;

  // First-login minimum: name + grade + school + parent name.
  // Parent contact (email/phone) + target score remain optional.
  if (!fullName || !grade || !school || !parentName) {
    return NextResponse.json(
      { error: "Missing required fields: fullName, grade, school, parentName" },
      { status: 400 }
    );
  }

  const db = getServiceClient();

  await db.from("users").update({ display_name: fullName }).eq("id", user.userId);

  const { error } = await db.from("student_profiles").upsert(
    {
      user_id: user.userId,
      grade,
      school: school ?? null,
      parent_name: parentName ?? null,
      parent_email: parentEmail ?? null,
      parent_phone: parentPhone ?? null,
      target_score: targetScore ?? null,
      current_level: currentLevel ?? null,
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.error("[complete-registration] DB error:", error);
    return NextResponse.json({ error: "Failed to save profile" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
