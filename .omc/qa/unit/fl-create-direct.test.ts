// node --experimental-strip-types .omc/qa/unit/fl-create-direct.test.ts
// Ticket fb38d638: Create Test → Full-length SAT picks its four modules
// directly. Covers lib/full-length-admin.ts parsePickedSections (Section-
// test rules per section + two modules each), pickedSectionsError (modules
// exist and are in their section), the approval rule the route applies
// (moduleApprovalError), and that createFullLengthTest builds the same
// parent + two hidden fl_section children from picked sections as from
// source tests (source_test_id null, Desmos on Math, SAT time limits,
// break default unchanged), so publish / runner / results see the usual shape.
import assert from "node:assert/strict";
import "./_resolve.ts";
import { fakeDb } from "./_fake-db.ts";
const fla = await import("../../../lib/full-length-admin.ts");
const readiness = await import("../../../lib/test-readiness.ts");
// The route's moduleApprovalError (app/api/admin/_shared.ts, not loadable
// here: next/server) refuses a module with pending questions or none approved.
const approvalError = async (client: unknown, ids: string[]) => {
  const bad = (await readiness.moduleApprovals(client as never, ids.map((id) => ({ id, label: id })))).filter((m) => m.pending > 0 || m.approved === 0);
  return bad.length ? `not Approved: ${bad.map((m) => m.name).join(", ")}` : null;
};

const RW = "Reading & Writing";
const modules = [
  { id: "rw1", module_name: "RW M1", section: RW }, { id: "rw2", module_name: "RW M2", section: RW },
  { id: "rwE", module_name: "RW Easy", section: RW }, { id: "rwH", module_name: "RW Hard", section: RW },
  { id: "m1", module_name: "Math M1", section: "Math" }, { id: "m2", module_name: "Math M2", section: "Math" },
  { id: "mE", module_name: "Math Easy", section: "Math" }, { id: "mH", module_name: "Math Hard", section: "Math" },
];
const q = (module_id: string, parsing_status = "Approved") => ({ id: `${module_id}-${parsing_status}-${Math.random()}`, module_id, parsing_status });
function world() {
  return fakeDb({
    modules: structuredClone(modules),
    questions: modules.map((m) => q(m.id)),
    tests: [],
    test_assignments: [],
  });
}

const adaptiveRw = { isAdaptive: true, module1Id: "rw1", module2EasyId: "rwE", module2HardId: "rwH", adaptiveThreshold: 55 };
const linearMath = { isAdaptive: false, moduleId: "m1", module2Id: "m2" };

// ------------------------------------------------------------- parse ok
{
  const r = fla.parsePickedSections({ rw: adaptiveRw, math: linearMath });
  assert.equal(r.error, null);
  const { rw, math } = r.sections!;
  assert.deepEqual(
    [rw.id, rw.is_adaptive, rw.module_id, rw.module_2_id, rw.module_1_id, rw.module_2_easy_id, rw.module_2_hard_id, rw.adaptive_threshold, rw.desmos_enabled],
    [null, true, null, null, "rw1", "rwE", "rwH", 55, false],
  );
  assert.deepEqual(
    [math.is_adaptive, math.module_id, math.module_2_id, math.module_1_id, math.module_2_easy_id, math.adaptive_threshold, math.desmos_enabled],
    [false, "m1", "m2", null, null, 60, true],
    "linear Math: M1 + M2, default threshold, Desmos on",
  );
  assert.deepEqual([math.time_limit_minutes, math.time_limit_minutes_module_2, math.formula_sheet_url], [null, null, null]);
  // One adaptive track is enough (as on a Section test); fields of the
  // other mode are ignored.
  const one = fla.parsePickedSections({
    rw: { isAdaptive: true, module1Id: "rw1", module2HardId: "rwH", moduleId: "junk", module2Id: "junk2" },
    math: { ...linearMath, module2EasyId: "mE" },
  });
  assert.equal(one.error, null);
  assert.deepEqual([one.sections!.rw.module_id, one.sections!.rw.module_2_easy_id, one.sections!.rw.module_2_hard_id], [null, null, "rwH"]);
  assert.equal(one.sections!.math.module_2_easy_id, null);
  assert.equal(fla.parsePickedSections({ rw: { ...adaptiveRw, adaptiveThreshold: 72.6 }, math: linearMath }).sections!.rw.adaptive_threshold, 73);
}

// ---------------------------------------------------------- parse errors
{
  const cases: [unknown, RegExp][] = [
    [null, /both sections/],
    ["x", /both sections/],
    [{ rw: adaptiveRw }, /Choose the Math modules/],
    [{ rw: { isAdaptive: false, moduleId: "rw1" }, math: linearMath }, /Reading and Writing: choose Module 2/],
    [{ rw: { isAdaptive: false, moduleId: "rw1", module2Id: "rw1" }, math: linearMath }, /must be different/],
    [{ rw: { isAdaptive: false, module2Id: "rw2" }, math: linearMath }, /choose Module 1/],
    [{ rw: { isAdaptive: true, module1Id: "rw1" }, math: linearMath }, /at least one Module 2 track/],
    [{ rw: { isAdaptive: true, module1Id: "rw1", module2EasyId: "rw1" }, math: linearMath }, /differ from Module 1/],
    [{ rw: { ...adaptiveRw, adaptiveThreshold: 101 }, math: linearMath }, /threshold/],
    [{ rw: { ...adaptiveRw, adaptiveThreshold: "50" }, math: linearMath }, /threshold/],
    [{ rw: { isAdaptive: false, moduleId: 5, module2Id: "rw2" }, math: linearMath }, /invalid module id/],
    [{ rw: adaptiveRw, math: { isAdaptive: false, moduleId: "rw2", module2Id: "rwE" } }, /same module can't be used in both/],
    [{ rw: adaptiveRw, math: { isAdaptive: false, moduleId: "c0570000-5ca6-4000-8000-000000000001", module2Id: "m2" } }, /Custom test/],
  ];
  for (const [raw, re] of cases) {
    const r = fla.parsePickedSections(raw);
    assert.equal(r.sections, null, JSON.stringify(raw));
    assert.match(r.error!, re, JSON.stringify(raw));
  }
}

// ------------------------------------------------- section + approval
{
  const { db, client } = world();
  const ok = fla.parsePickedSections({ rw: adaptiveRw, math: linearMath }).sections!;
  assert.equal(await fla.pickedSectionsError(client, ok), null);
  // A Math module in the R&W block (section filtering, server side).
  const swapped = fla.parsePickedSections({ rw: { isAdaptive: false, moduleId: "rw1", module2Id: "m2" }, math: { isAdaptive: false, moduleId: "m1", module2Id: "mE" } }).sections!;
  assert.match((await fla.pickedSectionsError(client, swapped))!, /Reading and Writing section must only contain Reading & Writing modules/);
  const mathInRw = fla.parsePickedSections({ rw: adaptiveRw, math: { isAdaptive: false, moduleId: "m1", module2Id: "rw2" } }).sections!;
  assert.match((await fla.pickedSectionsError(client, mathInRw))!, /Math section must only contain Math modules/);
  const missing = fla.parsePickedSections({ rw: adaptiveRw, math: { isAdaptive: false, moduleId: "m1", module2Id: "gone" } }).sections!;
  assert.match((await fla.pickedSectionsError(client, missing))!, /no longer exist/);

  // Only fully approved modules (the route's moduleApprovalError, as on a Section test).
  const ids = [...fla.testModuleIds(ok.rw), ...fla.testModuleIds(ok.math)];
  assert.deepEqual(ids, ["rw1", "rwE", "rwH", "m1", "m2"]);
  assert.equal(await approvalError(client, ids), null);
  db.tables.questions.push(q("mE", "Needs Review"), q("m2", "Draft"));
  assert.match((await approvalError(client, ids))!, /not Approved: Math M2$/);
  db.tables.questions = db.tables.questions.filter((r) => r.module_id !== "rwH");
  assert.match((await approvalError(client, ["rwH"]))!, /RW Hard/, "a module with no approved questions is refused");
}

// ---------------------------------------------------------------- create
{
  const { db, client } = world();
  const sections = fla.parsePickedSections({ rw: adaptiveRw, math: linearMath }).sections!;
  // Route: entered limits, else the setup's (none), else SAT standard.
  const limits = {
    rw: fla.defaultSectionLimits(sections.rw, "rw"),
    math: fla.defaultSectionLimits(sections.math, "math"),
  };
  assert.deepEqual(limits, { rw: { m1: 32, m2: 32 }, math: { m1: 35, m2: 35 } });
  assert.equal(fla.FL_DEFAULT_BREAK_MINUTES, 10, "full-length break default unchanged");
  const res = await fla.createFullLengthTest(client, {
    testName: " Direct FL ",
    sources: sections,
    limits,
    breakMinutes: fla.FL_DEFAULT_BREAK_MINUTES,
    allowSectionPause: false,
    openDate: null,
    dueDate: null,
    showAnswersAfterSubmission: false,
    showExplanationsAfterSubmission: true,
    allowRetake: false,
    teacherIds: [],
    studentIds: ["s1"],
    classGroupIds: [],
    createdBy: "admin-qa",
  });
  assert.equal(res.error, null);
  const parent = db.tables.tests.find((t) => t.id === res.id)!;
  assert.deepEqual(
    [parent.test_kind, parent.test_name, parent.status, parent.break_minutes, parent.allow_section_pause, parent.module_id, parent.parent_test_id ?? null],
    ["full_length", "Direct FL", "Draft", 10, false, null, null],
  );
  const kids = db.tables.tests.filter((t) => t.parent_test_id === res.id);
  assert.equal(kids.length, 2, "two hidden section children");
  const rw = kids.find((k) => k.section_order === 1)!;
  const math = kids.find((k) => k.section_order === 2)!;
  assert.deepEqual(
    [rw.test_kind, rw.test_name, rw.is_adaptive, rw.module_1_id, rw.module_2_easy_id, rw.module_2_hard_id, rw.module_id, rw.adaptive_threshold, rw.desmos_enabled, rw.source_test_id, rw.time_limit_minutes, rw.time_limit_minutes_module_2],
    ["fl_section", "Direct FL — Reading and Writing", true, "rw1", "rwE", "rwH", null, 55, false, null, 32, 32],
  );
  assert.deepEqual(
    [math.test_kind, math.test_name, math.is_adaptive, math.module_id, math.module_2_id, math.module_1_id, math.desmos_enabled, math.source_test_id, math.time_limit_minutes, math.time_limit_minutes_module_2],
    ["fl_section", "Direct FL — Math", false, "m1", "m2", null, true, null, 35, 35],
  );
  for (const k of kids) assert.deepEqual([k.status, k.created_by, k.is_untimed, k.question_ids], ["Draft", "admin-qa", false, null]);
  assert.deepEqual(db.tables.test_assignments.map((a) => [a.test_id, a.student_ids]), [[res.id, ["s1"]]], "assignment on the parent only");

  // Publish check sees the usual shape: all modules of both sections.
  const { children } = await fla.loadChildTests(client, res.id!);
  const pub = fla.fullLengthPublishModules(children);
  assert.equal(pub.error, null);
  assert.deepEqual(pub.moduleIds, ["rw1", "rwE", "rwH", "m1", "m2"]);
  // Nobody started; re-sync's "source" is empty (picked directly).
  assert.deepEqual([children.rw!.source_test_id, children.math!.source_test_id], [null, null]);
  assert.deepEqual(await fla.fullLengthStarted(client, res.id!, [rw.id as string, math.id as string]), { started: false, error: null });
}

console.log("fl-create-direct: ok");
