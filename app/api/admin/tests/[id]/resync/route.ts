import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { getServiceClient } from "@/lib/supabase";
import { forbidCrossSide } from "@/lib/qa";
import { fullLengthLinks } from "@/lib/full-length";
import {
  FL_SECTIONS,
  FULL_LENGTH_DISABLED_MESSAGE,
  fullLengthEnabledFor,
  fullLengthStarted,
  loadChildTests,
  loadFullLengthSources,
  sourceSnapshot,
  testModuleIds,
  type FlSectionKey,
} from "@/lib/full-length-admin";
import { moduleSetError } from "../../../_shared";

// POST /api/admin/tests/[id]/resync — full-length SAT only.
// Body: { rwSourceTestId?, mathSourceTestId? } (omitted = keep the current source)
//
// Re-snapshots both sections' module setup (modules, adaptive threshold,
// math aids) from the source tests, optionally switching to other sources.
// Time limits stay as set on the full-length test. Only allowed on a
// Draft or Closed test that nobody has started (existing answers are tied
// to the old modules); publish / reopen re-run the approval check.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireRole("admin");
  if (authResult instanceof NextResponse) return authResult;
  const admin = authResult;
  const { id } = await params;

  let body: { rwSourceTestId?: unknown; mathSourceTestId?: unknown } = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
  for (const k of ["rwSourceTestId", "mathSourceTestId"] as const) {
    if (body[k] !== undefined && typeof body[k] !== "string") return bad(`${k} must be a test id`);
  }

  const crossSide = await forbidCrossSide(admin, {
    testIds: [id, body.rwSourceTestId as string | undefined, body.mathSourceTestId as string | undefined].filter(
      (x): x is string => Boolean(x),
    ),
  });
  if (crossSide) return crossSide;

  const db = getServiceClient();
  if (!(await fullLengthEnabledFor(db, admin))) return bad(FULL_LENGTH_DISABLED_MESSAGE, 403);

  let flIds: Set<string>;
  let isParent: boolean;
  try {
    const links = await fullLengthLinks(db);
    flIds = new Set([...links.parentOf.keys(), ...links.childrenOf.keys()]);
    isParent = links.childrenOf.has(id);
  } catch (e) {
    console.error("[admin/tests/resync] links", e);
    return bad("Could not load the test sections", 500);
  }
  if (!isParent) return bad("Only a full-length SAT test can be re-synced", 404);

  const { data: parent } = await db.from("tests").select("id, status").eq("id", id).maybeSingle();
  if (!parent) return bad("Test not found", 404);
  // Published tests can be started at any moment, so a re-sync could race
  // a student's first module. Only Draft (or Closed and never started).
  if (parent.status === "Published") {
    return bad("Close the test (or keep it in Draft) before re-syncing its sections.", 409);
  }
  const { children, error: loadErr } = await loadChildTests(db, id);
  if (loadErr) return bad(loadErr, 500);
  if (!children.rw || !children.math) return bad("This full-length test is missing a section", 409);

  const { started, error: startedErr } = await fullLengthStarted(db, id, [children.rw.id, children.math.id]);
  if (startedErr) return bad(startedErr, 500);
  if (started) {
    return bad(
      "Students have already started this test, so its source tests can't change. Create a new full-length test instead.",
      409,
    );
  }

  const ids: Record<FlSectionKey, string> = {
    rw: (body.rwSourceTestId as string | undefined) ?? children.rw.source_test_id ?? "",
    math: (body.mathSourceTestId as string | undefined) ?? children.math.source_test_id ?? "",
  };
  for (const s of FL_SECTIONS) {
    if (!ids[s.key]) return bad(`The ${s.label} source test was deleted — choose another one.`);
  }
  // Sources picked by default (unchanged) are re-checked for side too.
  const sideErr = await forbidCrossSide(admin, { testIds: [ids.rw, ids.math] });
  if (sideErr) return sideErr;

  const { sources, error: sourceErr } = await loadFullLengthSources(db, ids, flIds);
  if (sourceErr || !sources) return bad(sourceErr ?? "Invalid source tests");
  const setErr =
    (await moduleSetError(db, testModuleIds(sources.rw))) ?? (await moduleSetError(db, testModuleIds(sources.math)));
  if (setErr) return bad(setErr);

  for (const s of FL_SECTIONS) {
    const { error } = await db
      .from("tests")
      .update({ ...sourceSnapshot(sources[s.key]), updated_at: new Date().toISOString() })
      .eq("id", children[s.key]!.id);
    if (error) {
      console.error("[admin/tests/resync]", s.key, error);
      return bad("Failed to update the test sections", 500);
    }
  }
  await db.from("tests").update({ updated_at: new Date().toISOString() }).eq("id", id);
  return NextResponse.json({ success: true });
}
