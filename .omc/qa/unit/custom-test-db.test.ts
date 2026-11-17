// node --experimental-strip-types .omc/qa/unit/custom-test-db.test.ts
// Custom test storage (lib/custom-test/db): before migration 0035 nothing
// is enabled; a single-subject test is one section test owning its stage
// modules; R&W + Math is a full_length parent (break 0 by default) with two
// fl_section children; a failed insert leaves nothing behind; a Draft's
// questions can be swapped until someone starts; the family's questions.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import "./_resolve.ts";
import { fakeDb } from "./_fake-db.ts";
if (!existsSync(new URL("../../../lib/custom-test/db.ts", import.meta.url))) {
  console.log("custom-test-db: skipped (lib/custom-test not on this branch)");
  process.exit(0);
}
const D = await import("../../../lib/custom-test/db.ts");
const R = await import("../../../lib/custom-test/rules.ts");
const { parseStages, isStageModuleId } = await import("../../../lib/custom-test/stage.ts");
const { scopeToStudentQuestionSet } = await import("../../../lib/student-exam.ts");
type CustomRules = import("../../../lib/custom-test/rules.ts").CustomRules;
type Selection = import("../../../lib/custom-test/select.ts").Selection;

// ---- before the migration: not enabled, nothing written
{
  const { db, client } = fakeDb({ tests: [], modules: [] });
  db.errors.tests = { code: "42703", message: "column tests.custom_rules does not exist" };
  assert.equal(await D.customTestsReady(client), false);
  assert.match(D.NOT_ENABLED_MESSAGE, /migration 0035/);
}

const rules = (subject: "rw" | "math" | "both", adaptive: boolean, n: number): CustomRules => {
  const parts: CustomRules["parts"] = {};
  for (const k of R.partsOf(subject)) {
    const p = R.defaultPart(subject, k);
    p.questions = n;
    p.adaptive = adaptive;
    p.skills = R.defaultSkillCounts(k, n);
    p.minutes = R.suggestedPartMinutes(subject, k, p);
    parts[k] = p;
  }
  return { ...R.normalizeRules({ v: 1, subject, order: R.partsOf(subject), break: null, parts, seed: "", family_id: "", version: 1 }), seed: "s", family_id: "fam", version: 1 };
};
const sel = (r: CustomRules, prefix: string): Selection => ({
  parts: Object.fromEntries(
    r.order.map((k) => [k, R.partStages(r.subject, r.parts[k]!).map((s, i) => ({ key: s.key, questionIds: Array.from({ length: s.n }, (_, j) => `${prefix}${k}${i}-${j}`) }))]),
  ),
  shortfalls: [],
});
const settings = { testName: "Week 6", createdBy: "admin-1" };

// ---- single subject, adaptive
{
  const { db, client } = fakeDb({ tests: [], modules: [], test_assignments: [] });
  const r = rules("math", true, 8);
  const s = sel(r, "q");
  const { id, error } = await D.createCustomTest(client, r, s, settings);
  assert.equal(error, null);
  const t = db.tables.tests.find((x) => x.id === id)!;
  assert.equal(t.status, "Draft");
  assert.equal(t.test_kind, "section");
  assert.deepEqual(t.custom_rules, r);
  assert.equal(t.is_adaptive, true);
  assert.equal(t.adaptive_threshold, 60);
  assert.equal(t.module_id, null);
  for (const col of ["module_1_id", "module_2_easy_id", "module_2_hard_id"]) assert.ok(isStageModuleId(t[col]), col);
  assert.equal(t.time_limit_minutes, R.suggestedMinutes("math", 4));
  assert.equal(t.time_limit_minutes_module_2, R.suggestedMinutes("math", 4));
  assert.equal(t.desmos_enabled, true);
  const stages = parseStages(t.question_ids)!;
  assert.deepEqual(stages.get(t.module_2_hard_id as string), s.parts.math![2].questionIds);
  // Stage modules: placeholder rows owned by the test, Math, sizes, no PDF.
  const mods = db.tables.modules;
  assert.equal(mods.length, 3);
  assert.ok(mods.every((m) => m.owner_test_id === id && m.section === "Math" && m.pdf_url === "" && m.uploaded_by === "admin-1"));
  assert.deepEqual(mods.map((m) => [m.module_number, m.difficulty, m.total_questions]), [[1, "Mixed", 4], [2, "Easy", 4], [2, "Hard", 4]]);
  assert.equal(db.tables.test_assignments.length, 1);
  assert.deepEqual(db.tables.test_assignments[0].student_ids, []);
  // The exam paths read it back from the same row.
  const calls: unknown[] = [];
  const q = { eq: (...a: unknown[]) => (calls.push(a), q), in: (...a: unknown[]) => (calls.push(a), q) };
  scopeToStudentQuestionSet(q, t as never, t.module_1_id as string);
  assert.deepEqual(calls, [["parsing_status", "Approved"], ["id", s.parts.math![0].questionIds]]);
  // Load + selection round trip.
  const loaded = await D.loadCustomTest(client, id!);
  assert.deepEqual(D.selectionFromOwners(r, loaded!.owners), { ...s, shortfalls: [] });
}

// ---- single subject, fixed: one module
{
  const { db, client } = fakeDb({ tests: [], modules: [], test_assignments: [] });
  const r = rules("rw", false, 5);
  const { id } = await D.createCustomTest(client, r, sel(r, "q"), settings);
  const t = db.tables.tests.find((x) => x.id === id)!;
  assert.ok(isStageModuleId(t.module_id));
  assert.equal(t.module_2_id, null);
  assert.equal(t.time_limit_minutes_module_2, null);
  assert.equal(t.desmos_enabled, false);
  assert.equal(db.tables.modules.length, 1);
  assert.equal(db.tables.modules[0].section, "Reading & Writing");
}

// ---- R&W + Math: parent + two sections, no break by default
{
  const { db, client } = fakeDb({ tests: [], modules: [], test_assignments: [] });
  const r = rules("both", false, 6);
  assert.equal(r.break, null);
  const { id } = await D.createCustomTest(client, r, sel(r, "q"), settings);
  const parent = db.tables.tests.find((x) => x.id === id)!;
  assert.equal(parent.test_kind, "full_length");
  assert.equal(parent.break_minutes, 0, "no break unless the creator turns one on");
  assert.equal(parent.allow_section_pause, false);
  assert.equal(parent.question_ids, null);
  const kids = db.tables.tests.filter((x) => x.parent_test_id === id);
  assert.deepEqual(kids.map((k) => [k.test_kind, k.section_order, k.test_name]), [
    ["fl_section", 1, "Week 6 — Reading and Writing"],
    ["fl_section", 2, "Week 6 — Math"],
  ]);
  for (const k of kids) {
    assert.ok(isStageModuleId(k.module_id) && isStageModuleId(k.module_2_id), "each section has Module 1 + Module 2 (the runner needs both)");
    assert.equal(parseStages(k.question_ids)!.size, 2);
  }
  assert.ok(db.tables.modules.every((m) => kids.some((k) => k.id === m.owner_test_id)), "sections own their stage modules");
  assert.equal(db.tables.test_assignments[0].test_id, id, "assigned on the parent");
  // A break turned on is stored on the parent.
  const { db: db2, client: c2 } = fakeDb({ tests: [], modules: [], test_assignments: [] });
  const withBreak = { ...r, break: { minutes: 10, allowPause: true } };
  const { id: id2 } = await D.createCustomTest(c2, withBreak, sel(r, "q"), settings);
  const p2 = db2.tables.tests.find((x) => x.id === id2)!;
  assert.deepEqual([p2.break_minutes, p2.allow_section_pause], [10, true]);
}

// ---- a failed write leaves no half-built test
{
  const { db, client } = fakeDb({ tests: [], modules: [], test_assignments: [] });
  db.errors.modules = { message: "boom" };
  const r = rules("math", true, 6);
  const out = await D.createCustomTest(client, r, sel(r, "q"), settings);
  assert.equal(out.id, null);
  assert.match(String(out.error), /Failed/);
  assert.equal(db.tables.tests.length, 0, "the test row was deleted (stage modules cascade in the database)");
}

// ---- Draft edits: swap questions; locked once anyone started
{
  const { db, client } = fakeDb({ tests: [], modules: [], test_assignments: [], submissions: [], full_length_attempts: [] });
  const r = rules("rw", true, 6);
  const { id } = await D.createCustomTest(client, r, sel(r, "q"), settings);
  const next = sel(r, "n");
  next.parts.rw![1].questionIds = next.parts.rw![1].questionIds.slice(0, 2); // a shorter M2 easy
  assert.deepEqual(await D.replaceCustomQuestions(client, id!, r, next), { error: null, status: 200 });
  const t = db.tables.tests.find((x) => x.id === id)!;
  assert.deepEqual(parseStages(t.question_ids)!.get(t.module_2_easy_id as string), next.parts.rw![1].questionIds);
  assert.equal(db.tables.modules.find((m) => m.id === t.module_2_easy_id)!.total_questions, 2);
  // Shape changes are refused.
  const flipped = { ...r, parts: { rw: { ...r.parts.rw!, adaptive: false } } };
  assert.equal((await D.replaceCustomQuestions(client, id!, flipped, next)).status, 409);
  // Started → locked.
  db.tables.submissions.push({ id: "sub", test_id: id, student_id: "s" });
  const locked = await D.replaceCustomQuestions(client, id!, r, next);
  assert.equal(locked.status, 409);
  assert.match(String(locked.error), /locked/);
  // Published → refused too.
  db.tables.submissions.length = 0;
  t.status = "Published";
  assert.match(String((await D.replaceCustomQuestions(client, id!, r, next)).error), /Only a Draft/);
}

// ---- the family: every question of every version
{
  const { db, client } = fakeDb({ tests: [], modules: [], test_assignments: [] });
  const r1 = rules("both", false, 4);
  await D.createCustomTest(client, r1, sel(r1, "a"), settings);
  const r2 = { ...r1, version: 2 };
  await D.createCustomTest(client, r2, sel(r1, "b"), settings);
  // The fake db splits "custom_rules->>family_id" on "->": give it the ">family_id" key it then reads.
  for (const t of db.tables.tests) {
    const cr = t.custom_rules as Record<string, unknown> | undefined;
    if (cr) cr[">family_id"] = cr.family_id;
  }
  const fam = await D.familyQuestionIds(client, "fam");
  assert.equal(fam.versions, 2);
  assert.equal(fam.ids.size, 16, "4 R&W + 4 Math per version, from the sections");
  assert.ok([...fam.ids].every((q) => !isStageModuleId(q)));
}

console.log("custom-test-db: all assertions passed");
