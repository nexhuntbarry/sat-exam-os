import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getServiceClient } from "@/lib/supabase";

// POST /api/student/complete-registration
//
// Lazy-creates the Supabase user row if the Clerk webhook hasn't fired
// yet (race condition: a freshly signed-up user is redirected to
// /register/profile before svix delivers the user.created event). Without
// this fallback the form returned 401 because getCurrentUser() couldn't
// find the row.
export async function POST(req: Request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  if (!fullName || !grade || !school || !parentName) {
    return NextResponse.json(
      { error: "Missing required fields: fullName, grade, school, parentName" },
      { status: 400 }
    );
  }

  const db = getServiceClient();

  // Find or create the Supabase user row.
  let userRowId: string;
  const { data: existing } = await db
    .from("users")
    .select("id, role")
    .eq("clerk_user_id", clerkId)
    .maybeSingle();

  if (existing?.id) {
    userRowId = existing.id;
    if (existing.role && existing.role !== "student") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    await db
      .from("users")
      .update({ display_name: fullName, role: "student", updated_at: new Date().toISOString() })
      .eq("id", userRowId);
  } else {
    const cu = await currentUser();
    const email =
      cu?.primaryEmailAddress?.emailAddress ??
      cu?.emailAddresses?.[0]?.emailAddress ??
      "";
    if (!email) {
      return NextResponse.json({ error: "No email on Clerk user" }, { status: 400 });
    }
    const { data: created, error: insErr } = await db
      .from("users")
      .insert({
        clerk_user_id: clerkId,
        email,
        display_name: fullName,
        role: "student",
        account_status: "pending",
        avatar_url: cu?.imageUrl ?? null,
      })
      .select("id")
      .single();
    if (insErr || !created) {
      console.error("[complete-registration] user insert error:", insErr);
      return NextResponse.json({ error: "Failed to create user record" }, { status: 500 });
    }
    userRowId = created.id;
  }

  const { error } = await db.from("student_profiles").upsert(
    {
      user_id: userRowId,
      grade,
      school,
      parent_name: parentName,
      parent_email: parentEmail ?? null,
      parent_phone: parentPhone ?? null,
      target_score: targetScore ?? null,
      current_level: currentLevel ?? null,
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.error("[complete-registration] profile upsert error:", error);
    return NextResponse.json({ error: "Failed to save profile" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
