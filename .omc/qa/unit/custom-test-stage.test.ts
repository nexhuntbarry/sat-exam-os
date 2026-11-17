// node --experimental-strip-types .omc/qa/unit/custom-test-stage.test.ts
// Custom test stage lists (lib/custom-test/stage, plan custom-test.md D):
// a Custom test's modules own no questions; tests.question_ids lists each
// stage module id then its questions. Every exam path resolves them from
// the row it already loads. Checks: parsing, the scope filter chain (null
// stages = byte-identical to today), ordering, the PDF page viewer rule,
// teacher QA coverage, module-list hiding, and the 0/0 grade guard.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import "./_resolve.ts";
import { fakeDb } from "./_fake-db.ts";
// .omc/qa/unit is shared by every checkout: skip on a branch without the feature.
if (!existsSync(new URL("../../../lib/custom-test/stage.ts", import.meta.url))) {
  console.log("custom-test-stage: skipped (lib/custom-test not on this branch)");
  process.exit(0);
}
const S = await import("../../../lib/custom-test/stage.ts");
const { scopeToStudentQuestionSet, orderToQuestionIds, questionIdsSpanModules } = await import("../../../lib/student-exam.ts");
const { testShowsModulePage, studentPageGrant } = await import("../../../lib/module-page-scope.ts");
const { teacherQaOffQuestionsFrom } = await import("../../../lib/teacher-qa.ts");
const { finalizeSubmission } = await import("../../../lib/grade-submission.ts");

// ---- ids
const m1 = S.newStageModuleId();
const m2e = S.newStageModuleId();
const m2h = S.newStageModuleId();
assert.match(m1, /^c0570000-5ca6-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/, "valid UUID with the reserved prefix");
assert.notEqual(m1, m2e);
assert.equal(S.isStageModuleId(m1), true);
assert.equal(S.isStageModuleId(m1.toUpperCase()), true);
assert.equal(S.isStageModuleId("0be2ea31-7054-4517-8d80-a66060a8557d"), false, "an ordinary uuid");
assert.equal(S.isStageModuleId(null), false);
assert.equal(S.servesStageModules([null, "x", m2h]), true);
assert.equal(S.servesStageModules([null, "x"]), false);

// ---- parse / build
const qids = S.buildQuestionIds([
  { moduleId: m1, questionIds: ["q1", "q2"] },
  { moduleId: m2e, questionIds: ["q3"] },
  { moduleId: m2h, questionIds: ["q4", "q5"] },
]);
assert.deepEqual(qids, [m1, "q1", "q2", m2e, "q3", m2h, "q4", "q5"]);
assert.throws(() => S.buildQuestionIds([{ moduleId: "not-a-stage", questionIds: [] }]));
const stages = S.parseStages(qids)!;
assert.deepEqual([...stages.entries()], [[m1, ["q1", "q2"]], [m2e, ["q3"]], [m2h, ["q4", "q5"]]]);
assert.equal(S.parseStages(["q1", "q2"]), null, "a quick test's list is not a stage list");
assert.equal(S.parseStages([]), null);
assert.equal(S.parseStages(null), null);
assert.deepEqual(S.stagedQuestionIds(qids), ["q1", "q2", "q3", "q4", "q5"]);
assert.equal(S.stagedQuestionIds(["q1"]), null);
assert.deepEqual(S.stageQuestionIdsFor(qids, [m2h]), ["q4", "q5"]);
assert.deepEqual(S.stageQuestionIdsFor(qids, [m1, m2e]), ["q1", "q2", "q3"]);
assert.equal(S.stageQuestionIdsFor(qids, ["other-module"]), null);
assert.equal(S.stageOfQuestion(qids).get("q3"), m2e);
// Two sections' lists concatenated are still one valid list (review pages).
const both = [...qids, ...S.buildQuestionIds([{ moduleId: "c0570000-5ca6-4aaa-8bbb-cccccccccccc", questionIds: ["m9"] }])];
assert.deepEqual(S.stageQuestionIdsFor(both, ["c0570000-5ca6-4aaa-8bbb-cccccccccccc"]), ["m9"]);

// ---- scope: null stages leave the chain exactly as before
type Call = [string, string, unknown];
function run(test: Parameters<typeof scopeToStudentQuestionSet>[1], mods: string | string[]) {
  const calls: Call[] = [];
  const q = {
    eq(c: string, v: unknown) { calls.push(["eq", c, v]); return q; },
    in(c: string, v: unknown) { calls.push(["in", c, v]); return q; },
  };
  scopeToStudentQuestionSet(q, test, mods);
  return calls;
}
const APPROVED: Call = ["eq", "parsing_status", "Approved"];
assert.deepEqual(run({ module_id: "M1", is_adaptive: false, question_ids: null }, "M1"), [APPROVED, ["eq", "module_id", "M1"]]);
assert.deepEqual(run({ module_id: null, is_adaptive: true, question_ids: null }, ["A", "B"]), [APPROVED, ["in", "module_id", ["A", "B"]]]);
assert.deepEqual(
  run({ module_id: "M1", module_2_id: "M2", is_adaptive: false, question_ids: ["a"] }, "M2"),
  [APPROVED, ["eq", "module_id", "M2"], ["in", "id", ["a"]]],
  "legacy two-module subset unchanged",
);
// Stage modules: Approved + exactly the stage list, no module filter.
const adaptive = { module_id: null, module_1_id: m1, module_2_easy_id: m2e, module_2_hard_id: m2h, is_adaptive: true, question_ids: qids };
assert.deepEqual(run(adaptive, m1), [APPROVED, ["in", "id", ["q1", "q2"]]]);
assert.deepEqual(run(adaptive, m2h), [APPROVED, ["in", "id", ["q4", "q5"]]]);
assert.deepEqual(run(adaptive, [m1, m2e, m2h]), [APPROVED, ["in", "id", ["q1", "q2", "q3", "q4", "q5"]]], "review: every stage");
const fixedTwo = { module_id: m1, module_2_id: m2e, is_adaptive: false, question_ids: S.buildQuestionIds([{ moduleId: m1, questionIds: ["a"] }, { moduleId: m2e, questionIds: ["b"] }]) };
assert.deepEqual(run(fixedTwo, m2e), [APPROVED, ["in", "id", ["b"]]]);
const single = { module_id: m1, module_2_id: null, is_adaptive: false, question_ids: S.buildQuestionIds([{ moduleId: m1, questionIds: ["a", "b"] }]) };
assert.deepEqual(run(single, m1), [APPROVED, ["in", "id", ["a", "b"]]]);
assert.equal(questionIdsSpanModules(fixedTwo, [m1]), false, "spanning rule unchanged for two-module tests");

// ---- order: always the stage lists' order
const rows = ["q5", "q1", "q3", "zz", "q2"].map((id) => ({ id }));
assert.deepEqual(orderToQuestionIds(rows, adaptive, [m1], (r) => r.id).map((r) => r.id), ["q1", "q2", "q3", "q5", "zz"]);
assert.deepEqual(orderToQuestionIds(rows, adaptive, [], (r) => r.id).map((r) => r.id), ["q1", "q2", "q3", "q5", "zz"], "result pages pass no module");
const plain = [{ id: "b" }, { id: "a" }];
assert.deepEqual(orderToQuestionIds(plain, { module_id: "M", is_adaptive: true, question_ids: null }, ["M"], (r) => r.id), plain, "others unchanged");

// ---- PDF page viewer: a served stage shows the pages of its own questions only
const pageTest = { id: "t", ...adaptive };
assert.equal(testShowsModulePage(pageTest, "SRC", ["q4"], [m2h]), true);
assert.equal(testShowsModulePage(pageTest, "SRC", ["q4"], [m2e]), false, "the other track's question");
assert.equal(testShowsModulePage(pageTest, "SRC", ["zz"]), false);
assert.equal(testShowsModulePage(pageTest, "SRC", ["q3"]), true, "any stage of the test");
assert.deepEqual(
  studentPageGrant([{ test_id: "t", module_id: m1, status: "In Progress", attempt_number: 1 }], new Map([["t", pageTest]]), "SRC", ["q2"]),
  { live: true, reviewTestIds: [] },
);

// ---- teacher QA off: a Custom test covers exactly its questions
const off = teacherQaOffQuestionsFrom([
  { id: "t", module_id: null, module_2_id: null, module_1_id: m1, module_2_easy_id: m2e, module_2_hard_id: m2h, question_ids: qids, is_adaptive: true },
]);
assert.equal(off.covers({ id: "q4", module_id: "SRC" }), true);
assert.equal(off.covers({ id: "other", module_id: "SRC" }), false);

// ---- module lists leave stage modules out with one id range
const or: string[] = [];
S.hideStageModules({ or(f: string) { or.push(f); return this; } });
assert.equal(or.length, 1);
const [lo, hi] = or[0].split(",").map((p) => p.replace(/^id\.(lt|gt)\./, ""));
for (let i = 0; i < 50; i++) {
  const id = S.newStageModuleId();
  assert.ok(id > lo && id < hi, "every stage id sorts inside the hidden range");
}
for (const real of ["0be2ea31-7054-4517-8d80-a66060a8557d", "c0570000-5ca5-4fff-8fff-ffffffffffff", "c0570000-5ca6-5000-8000-000000000000", "ffffffff-ffff-4fff-bfff-ffffffffffff"]) {
  assert.ok(real < lo || real > hi, `${real} stays visible`);
}

// ---- grading never turns an empty stage into 0/0
{
  const { client } = fakeDb({
    modules: [{ id: m1, section: "Math" }],
    questions: [{ id: "gone", module_id: "SRC", parsing_status: "Needs Review", correct_answer: "A", question_type: "MC", question_text: "", original_question_number: 1 }],
    submissions: [{ id: "s1", status: "In Progress", session_id: null, started_at: new Date().toISOString(), metadata: {} }],
  });
  await assert.rejects(
    finalizeSubmission({
      submissionId: "s1",
      submission: { id: "s1", test_id: "t", answers: {}, started_at: new Date().toISOString(), module_id: m1, adaptive_track: "module_1" },
      test: { id: "t", module_id: m1, module_2_id: null, is_adaptive: false, question_ids: S.buildQuestionIds([{ moduleId: m1, questionIds: ["gone"] }]), due_date: null },
      db: client,
    }),
    /resolved to no questions/,
  );
  // The row was never claimed: still In Progress.
  assert.equal((client.tables.submissions[0] as { status: string }).status, "In Progress");
}
{
  // A served stage list grades exactly its Approved questions.
  const { client } = fakeDb({
    modules: [{ id: m1, section: "Math" }],
    questions: [
      { id: "a", module_id: "SRC1", parsing_status: "Approved", correct_answer: "A", question_type: "MC", question_text: "", original_question_number: 5 },
      { id: "b", module_id: "SRC2", parsing_status: "Approved", correct_answer: "B", question_type: "MC", question_text: "", original_question_number: 1 },
      { id: "c", module_id: "SRC2", parsing_status: "Approved", correct_answer: "C", question_type: "MC", question_text: "", original_question_number: 2 },
    ],
    submissions: [{ id: "s1", status: "In Progress", session_id: null, started_at: new Date().toISOString(), metadata: {} }],
    answer_records: [],
  });
  const r = await finalizeSubmission({
    submissionId: "s1",
    submission: { id: "s1", test_id: "t", answers: { a: "A", b: "C" }, started_at: new Date().toISOString(), module_id: m1, adaptive_track: "module_1" },
    test: { id: "t", module_id: m1, module_2_id: null, is_adaptive: false, question_ids: S.buildQuestionIds([{ moduleId: m1, questionIds: ["a", "b"] }]), due_date: null },
    db: client,
  });
  assert.equal(r?.totalQuestions, 2, "only the stage's questions (not c)");
  assert.equal(r?.correctCount, 1);
  assert.equal(r?.scaledSection, "Math");
}

console.log("custom-test-stage: all assertions passed");
