import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import {
  accommodationKind,
  FULL_LENGTH_DISABLED_MESSAGE,
  fullLengthEnabledFor,
  listAccommodations,
  multiplierError,
  setAccommodation,
  studentOnFullLengthTest,
} from "@/lib/full-length-admin";
import { roleError } from "../../../_shared";

// Per-student extended time on a full-length SAT test or a section test
// (test_time_accommodations). A change applies to attempts started
// afterwards: each attempt snapshots its multiplier at start.

// GET /api/admin/tests/[id]/accommodations → { data: [{ student_id, time_multiplier, updated_at }] }
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const { id } = await params;
  const crossSide = await forbidCrossSide(authResult, { testIds: [id] });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  const { data, error } = await listAccommodations(db, id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ data });
}

// PUT /api/admin/tests/[id]/accommodations  { studentId, multiplier: 1.25 | 1.5 | 2 | null }
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const admin = authResult;
  const { id } = await params;

  let body: { studentId?: unknown; multiplier?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
  if (typeof body.studentId !== "string" || !body.studentId) return bad("studentId is required");
  if (body.multiplier === undefined) return bad("multiplier is required (null clears it)");
  const multErr = multiplierError(body.multiplier);
  if (multErr) return bad(multErr);

  const crossSide = await forbidCrossSide(admin, { testIds: [id], userIds: [body.studentId] });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  const { data: test, error: testErr } = await db
    .from("tests")
    .select("test_kind, parent_test_id")
    .eq("id", id)
    .maybeSingle();
  if (testErr) return bad("Could not load the test", 500);
  if (!test) return bad("Test not found", 404);
  const kind = accommodationKind(test);
  if (!kind) return bad("Set extended time on the full-length SAT test, not on one of its sections", 400);
  // The full-length flag only gates full-length tests.
  if (kind === "full_length" && !(await fullLengthEnabledFor(db, admin))) return bad(FULL_LENGTH_DISABLED_MESSAGE, 403);
  const roleErr = await roleError(db, [body.studentId], "student");
  if (roleErr) return bad(roleErr);
  // Clearing is always allowed (e.g. a student who left the class).
  if (body.multiplier !== null && !(await studentOnFullLengthTest(db, id, body.studentId))) {
    return bad("This student isn't assigned to this test and has no work on it");
  }

  const err = await setAccommodation(db, id, body.studentId, body.multiplier as number | null, admin.userId);
  if (err) return bad(err, 500);
  return NextResponse.json({ success: true });
}
