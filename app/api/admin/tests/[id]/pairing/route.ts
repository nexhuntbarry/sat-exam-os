import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { fullLengthLinksOrNone } from "@/lib/full-length";
import { getTestSections } from "@/lib/teacher-access";
import { writePairOverride, type PairingMode } from "@/lib/test-pairing";

// POST /api/admin/tests/[id]/pairing
//   Body: { mode: "auto" } | { mode: "none" } | { mode: "pair", partnerId }
// Admin only. "Paired with" on the admin test page (lib/test-pairing): which
// test of the other section makes one R&W + Math set with this one. Kept
// symmetric (A ↔ B). Display only: no score is written. 503 until migration
// 0036_tests_pairing is applied.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;
  let body: { mode?: unknown; partnerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  let next: PairingMode;
  if (body.mode === "auto" || body.mode === "none") next = { mode: body.mode };
  else if (body.mode === "pair" && typeof body.partnerId === "string" && body.partnerId && body.partnerId !== id) {
    next = { mode: "pair", partnerId: body.partnerId };
  } else {
    return NextResponse.json({ error: 'mode must be "auto", "none" or "pair" (with partnerId of another test)' }, { status: 400 });
  }

  const ids = next.mode === "pair" ? [id, next.partnerId] : [id];
  const crossSide = await forbidCrossSide(authResult, { testIds: ids });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  try {
    const { data: rows, error } = await db.from("tests").select("id").in("id", ids);
    if (error) throw new Error(error.message);
    if ((rows ?? []).length !== ids.length) return NextResponse.json({ error: "Test not found" }, { status: 404 });
    // Section tests only: a full-length SAT (parent or section) keeps its own total.
    const links = await fullLengthLinksOrNone(db);
    if (ids.some((t) => links.childrenOf.has(t) || links.parentOf.has(t))) {
      return NextResponse.json({ error: "A full-length SAT keeps its own total and can't be paired." }, { status: 409 });
    }
    if (next.mode === "pair") {
      const sections = await getTestSections(db, ids, { strict: true });
      const a = sections.get(id);
      const b = sections.get(next.partnerId);
      const known = (s: string | null | undefined) => s === "Math" || s === "Reading & Writing";
      if (!known(a) || !known(b) || a === b) {
        return NextResponse.json({ error: "Pick a test of the other section (one R&W test with one Math test)." }, { status: 409 });
      }
    }
    if ((await writePairOverride(db, id, next)) === "column-missing") {
      return NextResponse.json(
        { error: "Database update pending: run migration 0036_tests_pairing first.", code: "db_update_pending" },
        { status: 503 },
      );
    }
  } catch (e) {
    console.error("[admin/tests/pairing]", e);
    return NextResponse.json({ error: "Failed to update the pairing" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...next });
}
