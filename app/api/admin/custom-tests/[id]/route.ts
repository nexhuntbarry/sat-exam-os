import { NextResponse } from "next/server";
import { forbidCrossSide } from "@/lib/qa";
import { customTestAdmin, familyExclusions, parseSelection, poolFor } from "@/lib/custom-test/api";
import { loadCustomTest, replaceCustomQuestions } from "@/lib/custom-test/db";
import { normalizeRules, rulesErrors, type CustomRules } from "@/lib/custom-test/rules";
import { selectionErrors } from "@/lib/custom-test/select";
import { withQueueInvalidation } from "@/lib/review-queue-cache";

// PATCH /api/admin/custom-tests/[id] — change a Draft's questions (and its
// rules: counts, mixes, times; not the subject or module shape).
// Body: { rules, seed, selection }. Refused once any student has started
// (questions are locked then; Make another version instead). The
// selection is re-checked against the bank like a new test; the test's
// own questions don't count as an earlier version.
async function handlePATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await customTestAdmin();
  if (ctx instanceof NextResponse) return ctx;
  const { admin, db } = ctx;
  const { id } = await params;
  const crossSide = await forbidCrossSide(admin, { testIds: [id] });
  if (crossSide) return crossSide;
  let body: { rules?: unknown; seed?: unknown; selection?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
  const errors = rulesErrors(body.rules);
  if (errors.length > 0) return bad(errors.join("; "));
  const selection = parseSelection(body.selection);
  if (!selection) return bad("The preview is missing — generate it again");

  try {
    const loaded = await loadCustomTest(db, id);
    if (!loaded) return bad("Not a Custom test", 404);
    const saved = loaded.test.custom_rules!;
    const [pool, family] = await Promise.all([poolFor(db, admin), familyExclusions(db, saved.family_id)]);
    // This test's own questions may stay; other versions' may not.
    const mine = new Set(Object.values(loaded.owners).flatMap((o) => (o?.question_ids ?? []) as string[]));
    const exclude = new Set([...family.ids].filter((q) => !mine.has(q)));
    const rules = normalizeRules(body.rules as CustomRules);
    const problems = selectionErrors(pool.questions, rules, selection, { exclude, allowReuse: saved.allow_reuse });
    if (problems.length > 0) return bad(problems.join("; "), 409);
    rules.seed = typeof body.seed === "string" ? body.seed.slice(0, 40) : saved.seed;
    rules.family_id = saved.family_id;
    rules.version = saved.version;
    if (saved.allow_reuse) rules.allow_reuse = true;
    rules.shortfalls = selection.shortfalls.map((s) => ({ ...s, message: String(s.message).slice(0, 300) }));
    const r = await replaceCustomQuestions(db, id, rules, selection);
    if (r.error) return bad(r.error, r.status);
    return NextResponse.json({ data: { id } });
  } catch (e) {
    console.error("[custom-tests/patch]", e);
    return bad("Failed to save the questions", 500);
  }
}

export const PATCH = withQueueInvalidation(handlePATCH);
