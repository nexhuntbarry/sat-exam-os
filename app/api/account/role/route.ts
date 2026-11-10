import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getServiceClient } from "@/lib/supabase";
import { syncRoleSideTables } from "@/lib/role-change";

// POST /api/account/role { role: "student" | "teacher" }
//
// Self-service "I signed up with the wrong role" switch, shown on the
// pending screen and on /register/role. Only the caller's own row, only
// while it is still PENDING (never approved/suspended accounts), only
// between student and teacher, and only before any test attempt exists.
// After approval, role changes go through the admin "Change role" action.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const to = body.role;
  if (to !== "student" && to !== "teacher") {
    return NextResponse.json({ error: "role must be student or teacher" }, { status: 400 });
  }

  const from = user.role;
  if (from === to) return NextResponse.json({ ok: true, role: to });

  if ((from !== "student" && from !== "teacher") || user.accountStatus !== "pending") {
    return NextResponse.json(
      {
        error:
          "Your account is already set up, so you can't change your role yourself. Please ask an administrator.",
      },
      { status: 409 },
    );
  }

  const db = getServiceClient();
  const { count, error: subErr } = await db
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("student_id", user.userId);
  if (subErr) {
    console.error("[account/role] submissions lookup failed:", subErr);
    return NextResponse.json({ error: "Failed to check test attempts" }, { status: 500 });
  }
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      {
        error:
          "This account already has test attempts, so you can't change your role yourself. Please ask an administrator.",
      },
      { status: 409 },
    );
  }

  const { data: meta } = await db.from("users").select("metadata").eq("id", user.userId).maybeSingle();
  const metadata = (meta?.metadata && typeof meta.metadata === "object" ? meta.metadata : {}) as Record<string, unknown>;
  const history = Array.isArray(metadata.role_changes) ? metadata.role_changes : [];
  const now = new Date().toISOString();

  // Guard on the current role + pending status in the UPDATE itself so a
  // concurrent admin approval can't be overridden.
  const { data: updated, error } = await db
    .from("users")
    .update({
      role: to,
      // Question-review is a teacher-only flag.
      ...(to !== "teacher" ? { can_review_questions: false } : {}),
      metadata: {
        ...metadata,
        ...(to === "teacher" ? { self_signup: true } : {}),
        role_changes: [...history, { from, to, by: "self", at: now }],
      },
      updated_at: now,
    })
    .eq("id", user.userId)
    .eq("role", from)
    .eq("account_status", "pending")
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[account/role] update failed:", error);
    return NextResponse.json({ error: "Failed to change role" }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json(
      { error: "Your account changed in the meantime. Please reload the page." },
      { status: 409 },
    );
  }

  const sideErr = await syncRoleSideTables(db, user.userId, to);
  if (sideErr) {
    console.error("[account/role]", sideErr);
    return NextResponse.json({ error: sideErr }, { status: 500 });
  }

  return NextResponse.json({ ok: true, role: to });
}
