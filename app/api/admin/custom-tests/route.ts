import { NextResponse } from "next/server";
import { getQaTestIds, scopeIds } from "@/lib/qa";
import { fullLengthEnabledFor, FULL_LENGTH_DISABLED_MESSAGE } from "@/lib/full-length-admin";
import { customTestAdmin, familyExclusions, parseSelection, poolFor } from "@/lib/custom-test/api";
import { createCustomTest } from "@/lib/custom-test/db";
import { normalizeRules, rulesErrors, type CustomRules } from "@/lib/custom-test/rules";
import { selectionErrors } from "@/lib/custom-test/select";
import { testNameError } from "../_shared";
import { withQueueInvalidation } from "@/lib/review-queue-cache";

// POST /api/admin/custom-tests — Save as Draft.
// Body: { name, rules, seed, selection, familyId?, allowReuse?, allowDuplicateName? }
// The selection is re-checked against the bank now (never trusted): every
// question eligible, no repeats or copies, module sizes, the skill cap and
// (another version) no earlier version's question unless reuse was ticked.
// Creates the test (or full-length parent + sections) as a Draft with an
// empty assignment; assign / publish / close as any other test.
async function handlePOST(req: Request) {
  const ctx = await customTestAdmin();
  if (ctx instanceof NextResponse) return ctx;
  const { admin, db } = ctx;
  let body: {
    name?: unknown;
    rules?: unknown;
    seed?: unknown;
    selection?: unknown;
    familyId?: unknown;
    allowReuse?: unknown;
    allowDuplicateName?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const bad = (error: string, status = 400, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status });

  const nameErr = testNameError(body.name);
  if (nameErr) return bad(nameErr);
  const name = String(body.name).trim();
  const errors = rulesErrors(body.rules);
  if (errors.length > 0) return bad(errors.join("; "), 400, { errors });
  const selection = parseSelection(body.selection);
  if (!selection) return bad("The preview is missing — generate it again");
  const raw = body.rules as CustomRules;
  if (raw.subject === "both" && !(await fullLengthEnabledFor(db, admin))) return bad(FULL_LENGTH_DISABLED_MESSAGE, 403);

  if (body.allowDuplicateName !== true) {
    const { data: dup } = await scopeIds(
      db.from("tests").select("id").ilike("test_name", name.replace(/[\\%_]/g, "\\$&")),
      "id",
      await getQaTestIds(),
      admin.isQa,
    ).limit(1);
    if (dup && dup.length > 0) return bad("A test with this name already exists", 409, { code: "duplicate_name" });
  }

  try {
    const allowReuse = body.allowReuse === true;
    const [pool, family] = await Promise.all([poolFor(db, admin), familyExclusions(db, body.familyId)]);
    const rules = normalizeRules(raw);
    const problems = selectionErrors(pool.questions, rules, selection, { exclude: family.ids, allowReuse });
    if (problems.length > 0) return bad(problems.join("; "), 409, { errors: problems });

    const isVersion = typeof body.familyId === "string" && family.versions > 0;
    rules.seed = typeof body.seed === "string" ? body.seed.slice(0, 40) : "";
    rules.family_id = isVersion ? (body.familyId as string) : globalThis.crypto.randomUUID();
    rules.version = isVersion ? family.versions + 1 : 1;
    if (allowReuse) rules.allow_reuse = true;
    rules.shortfalls = selection.shortfalls.map((s) => ({ ...s, message: String(s.message).slice(0, 300) }));

    const { id, error } = await createCustomTest(db, rules, selection, { testName: name, createdBy: admin.userId });
    if (error || !id) return bad(error ?? "Failed to create the Custom test", 500);
    return NextResponse.json({ data: { id } }, { status: 201 });
  } catch (e) {
    console.error("[custom-tests/post]", e);
    return bad("Failed to create the Custom test", 500);
  }
}

export const POST = withQueueInvalidation(handlePOST);
