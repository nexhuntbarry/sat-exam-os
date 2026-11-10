import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { syncRoleSideTables, type SwitchableRole } from "@/lib/role-change";

// POST /api/admin/users/[id]/role { role: "student" | "teacher" | "admin" }
//
// Admin "Change role". The account ends up APPROVED in its new role.
//   student → teacher: refused while a test attempt is in progress; class
//     memberships are dropped, submissions + student_profiles are kept.
//   teacher → student: class (teacher) assignments are dropped.
//   → admin, or changing an existing admin: super admins only; a super
//     admin's role can't be changed here.
// Each change is appended to users.metadata.role_changes for audit.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const me = authResult;

  const { id } = await params;
  const crossSide = await forbidCrossSide(me, { userIds: [id] });
  if (crossSide) return crossSide;

  let body: { role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const to = body.role;
  if (to !== "student" && to !== "teacher" && to !== "admin") {
    return NextResponse.json({ error: "role must be student, teacher or admin" }, { status: 400 });
  }

  if (id === me.userId) {
    return NextResponse.json({ error: "You can't change your own role" }, { status: 403 });
  }

  const db = getServiceClient();
  const { data: target } = await db
    .from("users")
    .select("id, role, account_status, is_super_admin, metadata")
    .eq("id", id)
    .maybeSingle();
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const from = target.role as SwitchableRole;
  if (from !== "student" && from !== "teacher" && from !== "admin") {
    return NextResponse.json({ error: `Unsupported current role: ${String(target.role)}` }, { status: 400 });
  }
  if (from === to) {
    return NextResponse.json({ error: `Already a ${to}` }, { status: 409 });
  }
  if ((to === "admin" || from === "admin") && !me.isSuperAdmin) {
    return NextResponse.json(
      { error: "Only super admins can make or change admins" },
      { status: 403 },
    );
  }
  if (target.is_super_admin) {
    return NextResponse.json(
      { error: "A super admin's role can't be changed" },
      { status: 403 },
    );
  }

  // Past attempts stay; an in-progress one would be orphaned mid-test.
  let attemptCount = 0;
  if (from === "student") {
    const { data: subs, error: subErr } = await db
      .from("submissions")
      .select("status")
      .eq("student_id", id);
    if (subErr) {
      console.error("[change-role] submissions lookup failed:", subErr);
      return NextResponse.json({ error: "Failed to check test attempts" }, { status: 500 });
    }
    if ((subs ?? []).some((s) => s.status === "In Progress")) {
      return NextResponse.json(
        { error: "This student has a test in progress. Wait until it's submitted, then try again." },
        { status: 409 },
      );
    }
    attemptCount = subs?.length ?? 0;
  }

  const metadata = (target.metadata && typeof target.metadata === "object" ? target.metadata : {}) as Record<string, unknown>;
  const history = Array.isArray(metadata.role_changes) ? metadata.role_changes : [];
  const now = new Date().toISOString();

  const { data: updated, error } = await db
    .from("users")
    .update({
      role: to,
      account_status: "approved",
      // Question-review is a teacher-only flag; never carry it to another role.
      ...(to !== "teacher" ? { can_review_questions: false } : {}),
      metadata: {
        ...metadata,
        role_changes: [...history, { from, to, by: me.userId, at: now }],
      },
      updated_at: now,
    })
    .eq("id", id)
    .eq("role", from)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("[change-role] update failed:", error);
    return NextResponse.json({ error: "Failed to change role" }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: "The account changed in the meantime. Reload and try again." }, { status: 409 });
  }

  const sideErr = await syncRoleSideTables(db, id, to);
  if (sideErr) {
    console.error("[change-role]", sideErr);
    return NextResponse.json({ error: `Role changed, but: ${sideErr}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, from, to, attemptCount });
}
